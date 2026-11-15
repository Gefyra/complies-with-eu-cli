import path from 'node:path';
import fs from 'fs-extra';
import { findConstraintPaths } from './constraintCheck.js';

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

/** True when an example has no usable validator result (must be reported as a failure). */
function exampleHasNoResult(parsed) {
  return !parsed || !parsed.summary || !!parsed.error;
}

/** Number of errors of an example; a missing result counts as one error. */
function exampleErrorCount(parsed) {
  const issues = (parsed && parsed.issues) || [];
  const errors = issues.filter(i => i.severity === 'fatal' || i.severity === 'error').length;
  return exampleHasNoResult(parsed) ? Math.max(errors, 1) : errors;
}

/**
 * Extracts the last path segment of a canonical URL for display.
 * e.g. "http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core" → "patient-eu-core"
 */
function shortName(canonical) {
  return canonical.split('/').pop();
}

/**
 * Turns a raw "slice error: ..." detail line into a table row [path, problem].
 *
 * The validator's "constraint ... missing" message carries no element path. When
 * the claimed EU SD is passed and exactly one of its elements declares that
 * constraint, its path is shown; otherwise the path stays "—".
 *
 * @param {string} raw
 * @param {object} [euSd] - The claimed EU StructureDefinition (optional)
 */
function parseSliceDetail(raw, euSd = null) {
  const text = raw.replace(/^slice error:\s*/i, '').trim();

  const minMaxMatch = text.match(
    /The (min|max) value of '([^']+)' on the path (\S+) does not comply with the value '([^']+)' from the claimed profile/
  );
  if (minMaxMatch) {
    return [mdCode(minMaxMatch[3]), `${minMaxMatch[1] === 'min' ? 'min' : 'max'}: is ${mdCode(minMaxMatch[2])}, expected ${mdCode(minMaxMatch[4])}`];
  }

  const constraintMatch = text.match(/The constraint '(.+)' is defined in the claimed profile, but missing/);
  if (constraintMatch) {
    const paths = euSd ? findConstraintPaths(euSd, constraintMatch[1]) : [];
    return [paths.length === 1 ? mdCode(paths[0]) : '—', `Constraint missing: ${mdCode(constraintMatch[1])}`];
  }

  const slicingMatch = text.match(/Mismatch in slicing at (\S+):/);
  if (slicingMatch) {
    return [mdCode(slicingMatch[1]), 'No slicing found, target profile expects slicing'];
  }

  return ['—', mdText(text)];
}

/**
 * Builds the rows of a per-EU-profile details table: identical rows (the
 * validator repeats e.g. the same constraint text for several elements) are
 * collapsed into one, in first-seen order, with "(reported N×)" appended.
 *
 * @param {string[]} details - Raw detail lines
 * @param {object}   [euSd]  - The claimed EU StructureDefinition (optional, see parseSliceDetail)
 * @returns {Array<[string, string]>} [path, problem] rows
 */
function buildDetailRows(details, euSd = null) {
  const rows = new Map(); // "path\0problem" → { path, problem, count }
  for (const d of details) {
    const [p, problem] = parseSliceDetail(d, euSd);
    const key = `${p}\u0000${problem}`;
    const row = rows.get(key);
    if (row) row.count++;
    else rows.set(key, { path: p, problem, count: 1 });
  }
  return [...rows.values()].map(({ path: p, problem, count }) =>
    [p, count > 1 ? `${problem} (reported ${count}×)` : problem]);
}

/**
 * Generates a Markdown compliance report from parsed validator console output.
 *
 * @param {object}   opts
 * @param {string}   opts.canonical      - The canonical URL of the validated profile
 * @param {string}   opts.packageSpec    - e.g. "de.gematik.isik@5.1.1"
 * @param {Array}    opts.euProfiles     - EU profiles: [{ url, version }] (optional; falls back to euCanonicals)
 * @param {string[]} opts.euCanonicals   - EU profile canonicals added as compliesWithProfile
 * @param {object}   opts.parsed         - Result of parseValidatorOutput: { summary, issues }
 * @param {string}   opts.reportPath     - Destination Markdown file path
 * @param {Map}      [opts.obligationViolationsByEuCanonical] - Map of euCanonical → violation[]
 * @param {Map}      [opts.filteredNonCompliantMap] - Pre-filtered nonCompliantMap (compliesWithProfile errors)
 * @param {Array}    [opts.autoSatisfiedConstraints] - Auto-resolved constraints: [{ euCanonical, expression, basePath, matchedChild }]
 * @param {Map}      [opts.euSdByCanonical] - Map of EU canonical (without version) → EU SD, used to recover element paths of missing constraints
 */
async function generateReport(opts) {
  const { canonical, packageSpec, euCanonicals, parsed, reportPath } = opts;
  // Build version lookup: url → version string (may be null/undefined)
  const euVersionMap = new Map(
    (opts.euProfiles || euCanonicals.map(u => ({ url: u, version: null })))
      .map(p => [p.url, p.version || null])
  );
  /** Returns the display string for a canonical with optional pipe-version */
  const withVersion = (url) => {
    const v = euVersionMap.get(url);
    return v ? `${url}|${v}` : url;
  };
  const { issues } = parsed;
  const euSdByCanonical = opts.euSdByCanonical ?? new Map();

  // Split compliesWithProfile errors from everything else
  const cwpErrors = issues.filter(i => i.msgId === 'SD_EXTENSION_COMPLIES_WITH_ERROR');
  const otherIssues = issues.filter(i => i.msgId !== 'SD_EXTENSION_COMPLIES_WITH_ERROR');

  // Build map: claimedCanonical → detail lines
  // Use pre-filtered map if provided (constraint check already applied)
  let nonCompliant;
  if (opts.filteredNonCompliantMap) {
    nonCompliant = opts.filteredNonCompliantMap;
  } else {
    nonCompliant = new Map();
    for (const issue of cwpErrors) {
      const m = issue.message.match(/claimed profile '([^']+)'/);
      if (m) nonCompliant.set(m[1], issue.details);
    }
  }

  // Count other issues by severity
  const bySeverity = { fatal: [], error: [], warning: [], information: [] };
  for (const issue of otherIssues) {
    const sev = issue.severity || 'information';
    if (bySeverity[sev]) bySeverity[sev].push(issue);
  }

  const lines = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`# Compliance Report: ${mdText(shortName(canonical))}`);
  lines.push('');
  lines.push(`**Profile:** ${mdCode(canonical)}`);
  lines.push(`**Package:** ${mdCode(packageSpec)} | **Date:** ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');

  // ── Section 1: Status overview ────────────────────────────────────────────
  const oblViolationsEarly = opts.obligationViolationsByEuCanonical ?? new Map();
  const isNonCompliant = (c) => nonCompliant.has(c) || oblViolationsEarly.has(c);
  const compliantCount = euCanonicals.filter(c => !isNonCompliant(c)).length;
  const nonCompliantCount = euCanonicals.filter(c => isNonCompliant(c)).length;
  const overallIcon = nonCompliantCount === 0 ? '✅' : '❌';

  lines.push(`## ${overallIcon} compliesWithProfile — Overview`);
  lines.push('');
  lines.push(`**${compliantCount} of ${euCanonicals.length}** checked EU profiles are fulfilled.`);
  lines.push('');
  lines.push('| Status | EU Profile |');
  lines.push('|:------:|------------|');
  for (const c of euCanonicals) {
    const icon = isNonCompliant(c) ? '❌' : '✅';
    lines.push(`| ${icon} | ${mdCell(mdCode(withVersion(c)))} |`);
  }
  lines.push('');

  // ── Section 2: Reasons per non-compliant profile ─────────────────────────
  const failedCanonicals = euCanonicals.filter(c => nonCompliant.has(c));
  if (failedCanonicals.length > 0) {
    lines.push('## Non-Compliant Profiles — Details');
    lines.push('');

    for (const c of failedCanonicals) {
      const details = nonCompliant.get(c) ?? [];
      lines.push(`### ❌ ${mdText(shortName(c))}`);
      lines.push('');
      lines.push(mdCode(withVersion(c)));
      lines.push('');

      if (details.length === 0) {
        lines.push('_No details available._');
      } else {
        lines.push('| Path | Issue |');
        lines.push('|------|-------|');
        const euSd = euSdByCanonical.get(c.split('|')[0]) ?? null;
        for (const [rowPath, problem] of buildDetailRows(details, euSd)) {
          lines.push(`| ${mdCell(rowPath)} | ${mdCell(problem)} |`);
        }
      }
      lines.push('');
    }
  }

  // ── Section 3: Obligation / MustSupport Violations ────────────────────────
  const oblViolations = oblViolationsEarly;
  if (oblViolations.size > 0) {
    const totalViol = [...oblViolations.values()].reduce((s, v) => s + v.length, 0);
    lines.push(`## ⚠️ Obligation Check (SHALL:able-to-populate)`);
    lines.push('');
    lines.push(
      `The FHIR Java Validator does **not** check obligations or MustSupport. ` +
      `The following evaluation therefore manually checks whether elements with \`SHALL:able-to-populate\` ` +
      `in the EU profile are at least marked as **MustSupport** in the validated profile ` +
      `and have a max cardinality > 0.`
    );
    lines.push('');
    lines.push(`**${totalViol} violation(s)** found across ${oblViolations.size} EU profile(s).`);
    lines.push('');

    for (const [euCan, violations] of oblViolations) {
      lines.push(`### 📋 ${mdText(shortName(euCan))}`);
      lines.push('');
      lines.push(mdCode(euCan));
      lines.push('');
      const inputLabel = mdCell(mdText(shortName(canonical)));
      lines.push(`| EU Element | Obligation | Issue | Cardinality (${inputLabel}) | MustSupport (${inputLabel}) |`);
      lines.push('|------------|-----------|-------|:-----------:|:-------------------:|');
      for (const v of violations) {
        const problems = [];
        if (v.matchType === 'notFound') {
          problems.push('Element not found in profile');
        } else {
          if (v.maxIsZero) problems.push('`max: 0` — element prohibited');
          if (v.missingMustSupport) problems.push('MustSupport missing');
        }
        const maxCell = v.matchType === 'notFound' ? '—' : (v.inputCardinality ?? '—');
        const msCell = v.matchType === 'notFound' ? '—' : (v.inputMustSupport ? '✅' : '❌');
        lines.push(`| ${mdCell(mdCode(v.euElementId))} | ${mdCell(mdCode(v.obligationCode))} | ${mdCell(problems.join(', '))} | ${mdCell(maxCell)} | ${msCell} |`);
      }
      lines.push('');
    }
  }

  // ── Section 4: Automatically resolved constraints ────────────────────────
  const autoResolved = opts.autoSatisfiedConstraints ?? [];
  const autoSatisfied = autoResolved.filter(i => i.kind !== 'type-slice');
  const typeSlices = autoResolved.filter(i => i.kind === 'type-slice');
  if (typeSlices.length > 0) {
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
    for (const item of typeSlices) {
      lines.push(
        `| ${mdCell(mdText(shortName(item.euCanonical)))} | ${mdCell(mdCode(item.basePath))} | ${mdCell(mdCode(item.type))} | ${mdCell(mdText(item.matchedChild))} |`
      );
    }
    lines.push('');
  }
  if (autoSatisfied.length > 0) {
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
    for (const item of autoSatisfied) {
      lines.push(
        `| ${mdCell(mdText(shortName(item.euCanonical)))} | ${mdCell(mdCode(item.basePath))} | ${mdCell(mdCode(item.expression))} | ${mdCell(mdText(item.matchedChild))} |`
      );
    }
    lines.push('');
  }

  // ── Section 5: Other validation results (collapsible) ────────────────────
  if (otherIssues.length > 0) {
    const severityLabels = { fatal: 'Fatal', error: 'Errors', warning: 'Warnings', information: 'Information' };
    const otherSummaryParts = ['fatal', 'error', 'warning', 'information']
      .filter(s => bySeverity[s].length > 0)
      .map(s => `${bySeverity[s].length} ${severityLabels[s]}`);

    lines.push('## Other Validation Results');
    lines.push('');
    lines.push('<details>');
    lines.push(`<summary>Not compliesWithProfile-specific: ${otherSummaryParts.join(', ')} — expand</summary>`);
    lines.push('');

    for (const sev of ['fatal', 'error', 'warning', 'information']) {
      const sevIssues = bySeverity[sev];
      if (sevIssues.length === 0) continue;

      lines.push(`### ${severityLabels[sev]}`);
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

  await fs.outputFile(reportPath, lines.join('\n'), 'utf8');
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
  const severityLabels = { fatal: 'Fatal', error: 'Errors', warning: 'Warnings', information: 'Information' };
  const lines = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`# Example Validation Report: ${mdText(shortName(canonical))}`);
  lines.push('');
  lines.push(`**Profile:** ${mdCode(canonical)}`);
  lines.push(`**Package:** ${mdCode(packageSpec)} | **Date:** ${new Date().toISOString().slice(0, 10)}`);
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
};
