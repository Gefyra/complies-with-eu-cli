import path from 'node:path';
import fs from 'fs-extra';
import {
  SEVERITIES,
  shortName,
  isoDate,
  parseSliceIssue,
  slicingIssueParts,
  buildDetailItems,
  buildReportModel,
  buildPackageModel,
  exampleHasNoResult,
  exampleErrorCount,
  groupObligationsByStrength,
} from './reportModel.js';

/**
 * Escapes text for use in Markdown/HTML outside code spans (reports are rendered
 * as HTML, e.g. with marked, so raw '<' must never reach the output).
 */
function mdText(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Makes a value safe inside a GFM table cell: escapes '|' and flattens newlines.
 * Apply it to the complete cell content (also around code spans).
 */
function mdCell(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/**
 * Wraps a value in a code span, using a backtick fence longer than any backtick
 * run inside the value.
 */
function mdCode(s) {
  const str = String(s ?? '').replace(/\r?\n/g, ' ');
  const longest = (str.match(/`+/g) || []).reduce((m, r) => Math.max(m, r.length), 0);
  const fence = '`'.repeat(longest + 1);
  const pad = str.startsWith('`') || str.endsWith('`') ? ' ' : '';
  return fence + pad + str + pad + fence;
}

/** Markdown of a structured detail issue (see reportModel.parseSliceIssue). */
function mdIssue(issue) {
  switch (issue.kind) {
    case 'cardinality':
      return `${issue.bound}: is ${mdCode(issue.actual)}, expected ${mdCode(issue.expected)}`;
    case 'constraint':
      return `Constraint missing: ${mdCode(issue.expression)}`;
    case 'slicing':
      return slicingIssueParts(issue).map(p => (typeof p === 'string' ? mdText(p) : mdCode(p.code))).join('');
    default:
      return mdText(issue.text);
  }
}

/**
 * Turns a raw "slice error: ..." detail line into a Markdown table row [path, problem].
 * See reportModel.parseSliceIssue; a path that cannot be determined is shown as "—".
 *
 * @param {string} raw
 * @param {object} [euSd] - The claimed EU StructureDefinition (optional)
 */
function parseSliceDetail(raw, euSd = null) {
  const { path: p, issue } = parseSliceIssue(raw, euSd);
  return [p ? mdCode(p) : '—', mdIssue(issue)];
}

/**
 * Builds the Markdown rows of a per-EU-profile details table: identical rows are
 * collapsed into one, in first-seen order, with "(reported N×)" appended.
 *
 * @param {string[]} details - Raw detail lines
 * @param {object}   [euSd]  - The claimed EU StructureDefinition (optional, see parseSliceDetail)
 * @returns {Array<[string, string]>} [path, problem] rows
 */
function buildDetailRows(details, euSd = null) {
  return mdDetailRows(buildDetailItems(details, euSd));
}

/** Markdown rows of detail items from the report model. */
function mdDetailRows(items) {
  return items.map(({ path: p, issue, count }) => {
    const problem = mdIssue(issue);
    return [p ? mdCode(p) : '—', count > 1 ? `${problem} (reported ${count}×)` : problem];
  });
}

const OBLIGATION_PROBLEM_MD = {
  notFound: 'Element not found in profile',
  maxZero: '`max: 0` — element prohibited',
  missingMustSupport: 'MustSupport missing',
};

const SEVERITY_LABELS = { fatal: 'Fatal', error: 'Errors', warning: 'Warnings', information: 'Information' };

/**
 * Renders the Markdown of a single-profile compliance report from the report model.
 *
 * @param {object} model - Result of reportModel.buildReportModel
 * @returns {string}
 */
function renderMarkdownReport(model) {
  const { summary } = model;
  const lines = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`# Compliance Report: ${mdText(model.title)}`);
  lines.push('');
  lines.push(`**Profile:** ${mdCode(model.canonical)}`);
  lines.push(`**Package:** ${mdCode(model.packageSpec)} | **Date:** ${model.date}`);
  lines.push('');

  // ── Section 1: Status overview ────────────────────────────────────────────
  lines.push(`## ${summary.nonCompliant === 0 ? '✅' : '❌'} compliesWithProfile — Overview`);
  lines.push('');
  lines.push(`**${summary.compliant} of ${summary.total}** checked EU profiles are fulfilled.`);
  lines.push('');
  lines.push('| Status | EU Profile |');
  lines.push('|:------:|------------|');
  for (const p of model.euProfiles) {
    lines.push(`| ${p.pass ? '✅' : '❌'} | ${mdCell(mdCode(p.display))} |`);
  }
  lines.push('');

  // ── Section 2: Reasons per non-compliant profile ─────────────────────────
  const failed = model.euProfiles.filter(p => p.compliesWithFailed);
  if (failed.length > 0) {
    lines.push('## Non-Compliant Profiles — Details');
    lines.push('');

    for (const p of failed) {
      lines.push(`### ❌ ${mdText(p.name)}`);
      lines.push('');
      lines.push(mdCode(p.display));
      lines.push('');

      if (p.details.length === 0) {
        lines.push('_No details available._');
      } else {
        lines.push('| Path | Issue |');
        lines.push('|------|-------|');
        for (const [rowPath, problem] of mdDetailRows(p.details)) {
          lines.push(`| ${mdCell(rowPath)} | ${mdCell(problem)} |`);
        }
      }
      lines.push('');
    }
  }

  // ── Section 3: Obligation / MustSupport Violations ────────────────────────
  if (model.obligations.length > 0) {
    lines.push(`## ⚠️ Obligation Check (able-to-populate)`);
    lines.push('');
    lines.push(
      `The FHIR Java Validator does **not** check obligations or MustSupport. ` +
      `The following evaluation therefore manually checks whether elements with \`SHALL:able-to-populate\` ` +
      `or \`SHOULD:able-to-populate\` in the EU profile are at least marked as **MustSupport** in the validated profile ` +
      `and have a max cardinality > 0. Violations of both make the EU profile fail.`
    );
    lines.push('');
    lines.push(`**${summary.obligationViolations} violation(s)** found across ${model.obligations.length} EU profile(s).`);
    lines.push('');

    for (const o of model.obligations) {
      lines.push(`### 📋 ${mdText(o.name)}`);
      lines.push('');
      lines.push(mdCode(o.euCanonical));
      lines.push('');
      const inputLabel = mdCell(mdText(model.title));
      for (const group of groupObligationsByStrength(o.violations)) {
        lines.push(`#### ${group.strength}:able-to-populate`);
        lines.push('');
        lines.push(`| EU Element | Obligation | Issue | Cardinality (${inputLabel}) | MustSupport (${inputLabel}) |`);
        lines.push('|------------|-----------|-------|:-----------:|:-------------------:|');
        for (const v of group.violations) {
          const problems = v.problems.map(k => OBLIGATION_PROBLEM_MD[k]).join(', ');
          const maxCell = v.notFound ? '—' : (v.cardinality ?? '—');
          const msCell = v.notFound ? '—' : (v.mustSupport ? '✅' : '❌');
          lines.push(`| ${mdCell(mdCode(v.euElementId))} | ${mdCell(mdCode(v.obligationCode))} | ${mdCell(problems)} | ${mdCell(maxCell)} | ${msCell} |`);
        }
        lines.push('');
      }
    }
  }

  // ── Section 4: Automatically resolved constraints ────────────────────────
  if (model.typeSlices.length > 0) {
    lines.push('## ℹ️ Optional EU type slices not allowed in this profile');
    lines.push('');
    lines.push(
      'The validator reported these optional type slices of the EU profile as missing. ' +
      'This profile does not allow the type at all, which is a permitted restriction, ' +
      'so they were excluded from the compliance result.'
    );
    lines.push('');
    lines.push('| EU Profile | EU slice | Type | Details |');
    lines.push('|-----------|----------|------|---------|');
    for (const item of model.typeSlices) {
      lines.push(
        `| ${mdCell(mdText(item.name))} | ${mdCell(mdCode(item.basePath))} | ${mdCell(mdCode(item.type))} | ${mdCell(mdText(item.matchedChild))} |`
      );
    }
    lines.push('');
  }
  if (model.autoResolved.length > 0) {
    lines.push('## ℹ️ Automatically resolved constraints');
    lines.push('');
    lines.push(
      'The following `.exists() or …` constraints were not declared by the input profile, ' +
      'but are structurally guaranteed by the profile\'s min cardinalities. ' +
      'They were excluded from the compliance result.'
    );
    lines.push('');
    lines.push('| EU Profile | Element | Constraint | Fulfilled by |');
    lines.push('|-----------|---------|------------|--------------|');
    for (const item of model.autoResolved) {
      lines.push(
        `| ${mdCell(mdText(item.name))} | ${mdCell(mdCode(item.basePath))} | ${mdCell(mdCode(item.expression))} | ${mdCell(mdText(item.matchedChild))} |`
      );
    }
    lines.push('');
  }

  // ── Section 5: Other validation results (collapsible) ────────────────────
  const { bySeverity } = model.otherIssues;
  if (model.otherIssues.total > 0) {
    const otherSummaryParts = SEVERITIES
      .filter(s => bySeverity[s].length > 0)
      .map(s => `${bySeverity[s].length} ${SEVERITY_LABELS[s]}`);

    lines.push('## Other Validation Results');
    lines.push('');
    lines.push('<details>');
    lines.push(`<summary>Not compliesWithProfile-specific: ${otherSummaryParts.join(', ')} — expand</summary>`);
    lines.push('');

    for (const sev of SEVERITIES) {
      const sevIssues = bySeverity[sev];
      if (sevIssues.length === 0) continue;

      lines.push(`### ${SEVERITY_LABELS[sev]}`);
      lines.push('');

      for (const issue of sevIssues) {
        const loc = [
          issue.location,
          issue.line ? `(line ${issue.line}, col ${issue.col})` : null,
        ].filter(Boolean).join(' ');

        lines.push(`**${mdText(loc || 'no location')}**${issue.msgId ? ` ${mdCode(issue.msgId)}` : ''}`);
        lines.push('');
        lines.push(`> ${mdText(issue.message).replace(/\r?\n/g, '\n> ')}`);
        lines.push('');
      }
    }

    lines.push('</details>');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generates a Markdown compliance report from parsed validator console output.
 * Accepts the options of reportModel.buildReportModel plus `reportPath`.
 *
 * @param {object} opts
 * @param {string} opts.reportPath - Destination Markdown file path
 * @returns {Promise<object>} The report model (reusable by other renderers)
 */
async function generateReport(opts) {
  const model = buildReportModel(opts);
  await fs.outputFile(opts.reportPath, renderMarkdownReport(model), 'utf8');
  return model;
}

/**
 * Renders the Markdown of a package report from reportModel.buildPackageModel.
 *
 * @param {object} model
 * @returns {string}
 */
function renderPackageMarkdown(model) {
  const { summary } = model;
  const lines = [
    `# Package Compliance Report: ${mdText(model.packageSpec)}`,
    '',
    `**Date:** ${model.date}`,
    `**Profiles:** ${summary.total} total, ${summary.compliant} compliant, ${summary.nonCompliant} non-compliant, ${summary.errored} with errors`,
    '',
    '## Profiles',
    '',
    '| Profile | Status | Report |',
    '|---------|--------|--------|',
  ];
  for (const p of model.profiles) {
    const status = p.error ? '⚠️ error' : (p.pass ? '✅' : '❌');
    lines.push(`| ${mdCell(mdText(p.name))} | ${status} | [Report](${p.slug}-report.md) |`);
  }
  lines.push('');
  return lines.join('\n');
}


/**
 * Generates a single combined Markdown validation report for all example instances.
 *
 * @param {object}    opts
 * @param {string}    opts.canonical      - Canonical URL of the validated profile
 * @param {string}    opts.packageSpec    - e.g. "de.gematik.isik@5.1.1"
 * @param {string[]}  opts.euCanonicals   - EU profile canonicals added as meta.profile
 * @param {Array<{fileName: string, parsed: object}>} opts.results - Per-example validator results
 * @param {string}    opts.reportPath     - Destination Markdown file path
 */
async function generateExampleReport({ canonical, packageSpec, euCanonicals, results, reportPath }) {
  const severityLabels = SEVERITY_LABELS;
  const lines = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`# Example Validation Report: ${mdText(shortName(canonical))}`);
  lines.push('');
  lines.push(`**Profile:** ${mdCode(canonical)}`);
  lines.push(`**Package:** ${mdCode(packageSpec)} | **Date:** ${isoDate()}`);
  lines.push('');

  // ── meta.profile Claims ───────────────────────────────────────────────────
  lines.push('## Checked meta.profile Claims');
  lines.push('');
  for (const c of euCanonicals) {
    lines.push(`- ${mdCode(c)}`);
  }
  lines.push('');

  // ── Overview table ────────────────────────────────────────────────────────
  const passCount = results.filter(({ parsed }) => exampleErrorCount(parsed) === 0).length;
  const overallIcon = passCount === results.length ? '✅' : '❌';

  lines.push(`## ${overallIcon} Overview — ${passCount} of ${results.length} example(s) error-free`);
  lines.push('');
  lines.push('| Status | File | Errors | Warnings |');
  lines.push('|:------:|------|-------:|----------:|');

  for (const { fileName, parsed } of results) {
    const issues = (parsed && parsed.issues) || [];
    const errors = exampleErrorCount(parsed);
    const warnings = issues.filter(i => i.severity === 'warning').length;
    const icon = errors === 0 ? '✅' : '❌';
    lines.push(`| ${icon} | ${mdCell(mdCode(fileName))} | ${errors} | ${warnings} |`);
  }
  lines.push('');

  // ── Per-example details ───────────────────────────────────────────────────
  lines.push('## Details per Example');
  lines.push('');

  for (const { fileName, parsed } of results) {
    const { summary, issues } = parsed || {};
    const bySeverity = { fatal: [], error: [], warning: [], information: [] };
    for (const issue of issues ?? []) {
      const sev = issue.severity || 'information';
      if (bySeverity[sev]) bySeverity[sev].push(issue);
    }
    const hasErrors = exampleErrorCount(parsed) > 0;
    const icon = hasErrors ? '❌' : '✅';

    lines.push(`### ${icon} ${mdText(fileName)}`);
    lines.push('');
    if (summary) {
      lines.push(`**${mdText(summary.result)}:** ${mdText(summary.text)}`);
      lines.push('');
    }
    if (exampleHasNoResult(parsed)) {
      lines.push(`**ERROR:** No validator result for this example${parsed && parsed.error ? ` (${mdText(parsed.error)})` : ''}. It is counted as failed.`);
      lines.push('');
    }

    const allEmpty = Object.values(bySeverity).every(a => a.length === 0);
    if (allEmpty) {
      if (!exampleHasNoResult(parsed)) {
        lines.push('_No issues._');
        lines.push('');
      }
      continue;
    }

    for (const sev of ['fatal', 'error', 'warning', 'information']) {
      const sevIssues = bySeverity[sev];
      if (sevIssues.length === 0) continue;

      lines.push(`#### ${severityLabels[sev]}`);
      lines.push('');
      for (const issue of sevIssues) {
        const loc = [
          issue.location,
          issue.line ? `(line ${issue.line}, col ${issue.col})` : null,
        ].filter(Boolean).join(' ');
        lines.push(`**${mdText(loc || 'no location')}**${issue.msgId ? ` ${mdCode(issue.msgId)}` : ''}`);
        lines.push('');
        lines.push(`> ${mdText(issue.message).replace(/\r?\n/g, '\n> ')}`);
        lines.push('');
      }
    }
  }

  await fs.outputFile(reportPath, lines.join('\n'), 'utf8');
}

/**
 * Appends an example-validation summary section to an existing main report file.
 *
 * @param {object}   opts
 * @param {string}   opts.mainReportPath  - Absolute path to the main report to append to
 * @param {Array<{fileName: string, parsed: object}>} opts.results - Per-example validator results
 * @param {string}   opts.exReportPath    - Absolute path to the detailed examples report
 */
async function appendExampleSummary({ mainReportPath, results, exReportPath }) {
  const relLink = path.relative(path.dirname(mainReportPath), exReportPath).replace(/\\/g, '/');

  const passCount = results.filter(({ parsed }) => exampleErrorCount(parsed) === 0).length;
  const overallIcon = passCount === results.length ? '✅' : '❌';

  const lines = [];
  lines.push('');
  lines.push(`## ${overallIcon} Example Validation — ${passCount} of ${results.length} error-free`);
  lines.push('');
  lines.push('| Status | File | Errors | Warnings |');
  lines.push('|:------:|------|-------:|----------:|');

  for (const { fileName, parsed } of results) {
    const issues = (parsed && parsed.issues) || [];
    const errors = exampleErrorCount(parsed);
    const warnings = issues.filter(i => i.severity === 'warning').length;
    const icon = errors === 0 ? '✅' : '❌';
    lines.push(`| ${icon} | ${mdCell(mdCode(fileName))} | ${errors} | ${warnings} |`);
  }

  lines.push('');
  lines.push(`→ [Details: Example Report](./${relLink})`);
  lines.push('');

  await fs.appendFile(mainReportPath, lines.join('\n'), 'utf8');
}

export {
  generateReport,
  generateExampleReport,
  appendExampleSummary,
  parseSliceDetail,
  buildDetailRows,
  mdText,
  mdCell,
  mdCode,
  exampleErrorCount,
  renderMarkdownReport,
  renderPackageMarkdown,
  buildReportModel,
  buildPackageModel,
};
