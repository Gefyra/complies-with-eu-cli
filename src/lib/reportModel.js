import { findConstraintPaths } from './constraintCheck.js';

/**
 * Renderer-independent report model.
 *
 * The validator results are turned into plain objects once; the Markdown
 * renderer (reportGen.js) and the HTML renderer (reportHtml.js) both render
 * from this model, so their content cannot drift apart. All string values are
 * raw (unescaped): each renderer escapes for its own output format.
 */

/** Severities in display order. */
const SEVERITIES = ['fatal', 'error', 'warning', 'information'];

/**
 * Extracts the last path segment of a canonical URL for display.
 * e.g. "http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core" → "patient-eu-core"
 */
function shortName(canonical) {
  return String(canonical ?? '').split('/').pop();
}

/** Today as YYYY-MM-DD (UTC, as in the existing reports). */
function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Turns a raw "slice error: ..." detail line of a compliesWithProfile error into
 * a structured item `{ path, issue }`.
 *
 * issue.kind is one of:
 * - 'cardinality' `{ bound: 'min'|'max', actual, expected }`
 * - 'constraint'  `{ expression }`
 * - 'slicing'     `{ reason, slice?, discriminator?, values?, actual?, expected?, text? }`
 *                 reason: 'unsliced' | 'extraSlice' | 'noSlice' | 'rules' | 'order' |
 *                 'discriminator' | 'other' (see parseSlicingReason)
 * - 'other'       `{ text }`
 *
 * The validator's "constraint ... missing" message carries no element path. When
 * the claimed EU SD is passed and exactly one of its elements declares that
 * constraint, its path is used; otherwise path is null.
 *
 * @param {string} raw
 * @param {object} [euSd] - The claimed EU StructureDefinition (optional)
 * @returns {{ path: string|null, issue: object }}
 */
function parseSliceIssue(raw, euSd = null) {
  const text = String(raw ?? '').replace(/^slice error:\s*/i, '').trim();

  const minMax = text.match(
    /The (min|max) value of '([^']+)' on the path (\S+) does not comply with the value '([^']+)' from the claimed profile/
  );
  if (minMax) {
    return {
      path: minMax[3],
      issue: { kind: 'cardinality', bound: minMax[1] === 'min' ? 'min' : 'max', actual: minMax[2], expected: minMax[4] },
    };
  }

  const constraint = text.match(/The constraint '(.+)' is defined in the claimed profile, but missing/);
  if (constraint) {
    const expression = constraint[1];
    const paths = euSd ? findConstraintPaths(euSd, expression) : [];
    return {
      path: paths.length === 1 ? paths[0] : null,
      issue: { kind: 'constraint', expression },
    };
  }

  const slicing = text.match(/^Mismatch in slicing(?: rules)? at (\S+):\s+(.*)$/);
  if (slicing) {
    return { path: slicing[1], issue: { kind: 'slicing', ...parseSlicingReason(slicing[2]) } };
  }

  return { path: null, issue: { kind: 'other', text } };
}

/** Strips Java wrappers such as "UriType[http://x]" from discriminator values. */
function cleanSlicingValues(values) {
  return String(values).replace(/\b[A-Za-z]+Type\[([^\]]*)\]/g, '$1');
}

/**
 * Structures the reason part of the validator's PROFILE_COMPLIES_WITH_SLICING_*
 * messages ("Mismatch in slicing[ rules] at <path>: <reason>"). Unknown wordings
 * keep their text (reason 'other'), so nothing the validator says gets lost.
 *
 * @param {string} reason
 * @returns {object}
 */
function parseSlicingReason(reason) {
  const text = String(reason ?? '').trim().replace(/\.$/, '');
  if (/^no slicing found\b/i.test(text)) return { reason: 'unsliced' };
  let m = text.match(/^extra slice '([^']+)' not found in the claimed profile/i);
  if (m) return { reason: 'extraSlice', slice: m[1] };
  m = text.match(/^no slice found for the discriminator (\S+) with the values (.+)$/i);
  if (m) return { reason: 'noSlice', discriminator: m[1], values: cleanSlicingValues(m[2]) };
  m = text.match(/^'([^']*)' when the claimed profile has '([^']*)'/i);
  if (m) return { reason: 'rules', actual: m[1], expected: m[2] };
  if (/^not ordered when the claimed profile has ordered/i.test(text)) return { reason: 'order' };
  m = text.match(/^the discriminator '([^']+)' was not found/i);
  if (m) return { reason: 'discriminator', discriminator: m[1] };
  return { reason: 'other', text };
}

/**
 * Wording of a slicing issue as parts: plain strings and `{ code }` spans, so the
 * Markdown and HTML renderers say exactly the same thing.
 *
 * @param {object} issue - A 'slicing' issue from parseSliceIssue
 * @returns {Array<string|{code: string}>}
 */
function slicingIssueParts(issue) {
  switch (issue.reason) {
    case 'unsliced':
      return ['No slicing found, target profile expects slicing'];
    case 'extraSlice':
      return ['Slice ', { code: issue.slice }, ' is not defined in the target profile'];
    case 'noSlice':
      return ['No matching slice for the target profile\'s slice (discriminator ', { code: issue.discriminator }, ', value ', { code: issue.values }, ')'];
    case 'rules':
      return ['Slicing rules are ', { code: issue.actual }, ', target profile has ', { code: issue.expected }];
    case 'order':
      return ['Slicing is not ordered, target profile requires ordered slices'];
    case 'discriminator':
      return ['Discriminator ', { code: issue.discriminator }, ' of the target profile not found'];
    default:
      return [`Slicing mismatch: ${issue.text ?? ''}`];
  }
}

/**
 * Builds the detail items of one EU profile: identical items (the validator
 * repeats e.g. the same constraint text for several elements) are collapsed into
 * one, in first-seen order, with a count.
 *
 * @param {string[]} details - Raw detail lines
 * @param {object}   [euSd]  - The claimed EU StructureDefinition (optional)
 * @returns {Array<{ path: string|null, issue: object, count: number }>}
 */
function buildDetailItems(details, euSd = null) {
  const items = new Map();
  for (const d of details ?? []) {
    const { path, issue } = parseSliceIssue(d, euSd);
    const key = JSON.stringify([path, issue]);
    const item = items.get(key);
    if (item) item.count++;
    else items.set(key, { path, issue, count: 1 });
  }
  return [...items.values()];
}

/** Normalises one obligation violation (see obligationCheck.js). */
function obligationItem(v) {
  const notFound = v.matchType === 'notFound';
  const problems = [];
  if (notFound) {
    problems.push('notFound');
  } else {
    if (v.maxIsZero) problems.push('maxZero');
    if (v.missingMustSupport) problems.push('missingMustSupport');
  }
  return {
    euElementId: v.euElementId,
    obligationCode: v.obligationCode,
    notFound,
    problems,
    cardinality: notFound ? null : (v.inputCardinality ?? null),
    mustSupport: notFound ? null : !!v.inputMustSupport,
  };
}

/** Normalises one validator issue for the "other validation results". */
function issueItem(issue) {
  return {
    severity: issue.severity || 'information',
    location: issue.location || null,
    line: issue.line || null,
    col: issue.col ?? null,
    msgId: issue.msgId || null,
    message: String(issue.message ?? ''),
  };
}

/**
 * Builds the model of a single-profile compliance report.
 *
 * @param {object}   opts
 * @param {string}   opts.canonical      - The canonical URL of the validated profile
 * @param {string}   opts.packageSpec    - e.g. "de.gematik.isik@5.1.1"
 * @param {Array}    [opts.euProfiles]   - EU profiles: [{ url, version }] (falls back to euCanonicals)
 * @param {string[]} opts.euCanonicals   - EU profile canonicals added as compliesWithProfile
 * @param {object}   opts.parsed         - Result of parseValidatorOutput: { summary, issues }
 * @param {Map}      [opts.obligationViolationsByEuCanonical] - euCanonical → violation[]
 * @param {Map}      [opts.filteredNonCompliantMap] - Pre-filtered nonCompliantMap (compliesWithProfile errors)
 * @param {Array}    [opts.autoSatisfiedConstraints] - [{ euCanonical, expression, basePath, matchedChild }];
 *   items with kind 'type-slice' ({ euCanonical, basePath, sliceName, type, matchedChild }) go to typeSlices
 * @param {Map}      [opts.euSdByCanonical] - EU canonical (without version) → EU SD
 * @param {object}   [opts.meta]         - Optional run metadata: { tool: { name, version, validatorVersion }, euPackages: [{ packageName, version }] }
 * @param {Date}     [opts.date]         - Report date (default: now)
 */
function buildReportModel(opts) {
  const { canonical, packageSpec, euCanonicals, parsed } = opts;
  const issues = (parsed && parsed.issues) || [];
  const euSdByCanonical = opts.euSdByCanonical ?? new Map();
  const oblMap = opts.obligationViolationsByEuCanonical ?? new Map();
  const versionOf = new Map(
    (opts.euProfiles || euCanonicals.map(u => ({ url: u, version: null })))
      .map(p => [p.url, p.version || null])
  );

  const cwpErrors = issues.filter(i => i.msgId === 'SD_EXTENSION_COMPLIES_WITH_ERROR');
  const otherIssues = issues.filter(i => i.msgId !== 'SD_EXTENSION_COMPLIES_WITH_ERROR');

  let nonCompliant = opts.filteredNonCompliantMap;
  if (!nonCompliant) {
    nonCompliant = new Map();
    for (const issue of cwpErrors) {
      const m = issue.message.match(/claimed profile '([^']+)'/);
      if (m) nonCompliant.set(m[1], issue.details);
    }
  }

  const resolvedItems = opts.autoSatisfiedConstraints ?? [];
  const autoResolved = resolvedItems.filter(item => item.kind !== 'type-slice').map(item => ({
    euCanonical: item.euCanonical,
    name: shortName(item.euCanonical),
    basePath: item.basePath,
    expression: item.expression,
    matchedChild: item.matchedChild,
  }));
  // Optional EU type slices whose type the validated profile does not allow
  const typeSlices = resolvedItems.filter(item => item.kind === 'type-slice').map(item => ({
    euCanonical: item.euCanonical,
    name: shortName(item.euCanonical),
    basePath: item.basePath,
    sliceName: item.sliceName ?? null,
    type: item.type ?? null,
    matchedChild: item.matchedChild,
  }));

  const obligations = [...oblMap].map(([euCanonical, violations]) => ({
    euCanonical,
    name: shortName(euCanonical),
    violations: violations.map(obligationItem),
  }));

  const euProfiles = euCanonicals.map((url) => {
    const version = versionOf.get(url) ?? null;
    const compliesWithFailed = nonCompliant.has(url);
    const obligation = obligations.find(o => o.euCanonical === url);
    return {
      canonical: url,
      version,
      display: version ? `${url}|${version}` : url,
      name: shortName(url),
      pass: !compliesWithFailed && !oblMap.has(url),
      compliesWithFailed,
      details: compliesWithFailed
        ? buildDetailItems(nonCompliant.get(url) ?? [], euSdByCanonical.get(url.split('|')[0]) ?? null)
        : [],
      obligationViolations: obligation ? obligation.violations : [],
      autoResolved: autoResolved.filter(a => a.euCanonical === url),
      typeSlices: typeSlices.filter(a => a.euCanonical === url),
    };
  });

  const bySeverity = Object.fromEntries(SEVERITIES.map(s => [s, []]));
  for (const issue of otherIssues) {
    const item = issueItem(issue);
    if (bySeverity[item.severity]) bySeverity[item.severity].push(item);
  }

  const compliant = euProfiles.filter(p => p.pass).length;
  return {
    kind: 'profile',
    title: shortName(canonical),
    canonical,
    packageSpec,
    date: isoDate(opts.date),
    meta: opts.meta ?? null,
    validatorSummary: parsed && parsed.summary ? parsed.summary.text ?? null : null,
    summary: {
      total: euProfiles.length,
      compliant,
      nonCompliant: euProfiles.length - compliant,
      obligationViolations: obligations.reduce((s, o) => s + o.violations.length, 0),
      pass: compliant === euProfiles.length,
    },
    euProfiles,
    obligations,
    autoResolved,
    typeSlices,
    otherIssues: {
      total: SEVERITIES.reduce((s, sev) => s + bySeverity[sev].length, 0),
      bySeverity,
    },
  };
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
 * Builds the model of the example validation of one profile (--examples).
 *
 * @param {object} opts
 * @param {string} opts.fhirType - Resource type of the examples
 * @param {Array<{fileName: string, resourceId?: string, parsed: object}>} opts.results - Per-example validator results ([] when none were found)
 * @param {string} [opts.reportPath] - Path of the Markdown examples report (if written)
 */
function buildExamplesModel({ fhirType, results, reportPath = null }) {
  const items = (results ?? []).map(({ fileName, resourceId, parsed }) => {
    const issues = (parsed && parsed.issues) || [];
    const errors = exampleErrorCount(parsed);
    const bySeverity = Object.fromEntries(SEVERITIES.map(s => [s, []]));
    for (const issue of issues) {
      const item = issueItem(issue);
      if (bySeverity[item.severity]) bySeverity[item.severity].push(item);
    }
    return {
      fileName,
      resourceId: resourceId ?? null,
      pass: errors === 0,
      errors,
      warnings: issues.filter(i => i.severity === 'warning').length,
      noResult: exampleHasNoResult(parsed),
      error: parsed && parsed.error ? String(parsed.error) : null,
      summaryText: parsed && parsed.summary ? parsed.summary.text ?? null : null,
      issueCount: issues.length,
      bySeverity,
    };
  });
  return {
    fhirType: fhirType ?? null,
    reportPath,
    total: items.length,
    passed: items.filter(e => e.pass).length,
    items,
  };
}

/**
 * Builds the model of a package report (validate-batch package mode).
 *
 * @param {object} opts
 * @param {string} opts.packageSpec
 * @param {Array}  opts.profiles - [{ canonical, slug, pass, error?, compliance? }]
 * @param {number} [opts.total]  - Number of profiles to validate (default: profiles.length)
 * @param {object} [opts.meta]   - See buildReportModel
 * @param {Date}   [opts.date]
 */
function buildPackageModel({ packageSpec, profiles, total, meta = null, date }) {
  const items = profiles.map(p => ({
    canonical: p.canonical,
    name: shortName(p.canonical),
    slug: p.slug,
    pass: !p.error && !!p.pass,
    error: p.error || null,
    compliance: (p.compliance || []).map(c => ({
      euCanonical: c.euCanonical,
      name: shortName(String(c.euCanonical).split('|')[0]),
      pass: !!c.pass,
    })),
  }));
  const errored = items.filter(p => p.error).length;
  const compliant = items.filter(p => !p.error && p.pass).length;
  return {
    kind: 'package',
    packageSpec,
    date: isoDate(date),
    meta,
    summary: {
      total: total ?? items.length,
      compliant,
      nonCompliant: items.length - compliant - errored,
      errored,
      pass: errored === 0 && compliant === items.length,
    },
    profiles: items,
  };
}

/**
 * Groups obligation violations by strength (SHALL first, then SHOULD, then
 * anything else) for rendering under separate headings (pure, for tests).
 * @param {Array<{strength?: string}>} violations
 * @returns {Array<{ strength: string, violations: Array }>}
 */
function groupObligationsByStrength(violations) {
  const order = ['SHALL', 'SHOULD'];
  const groups = new Map();
  for (const v of violations) {
    const key = v.strength || String(v.obligationCode || '').split(':')[0] || 'SHALL';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([strength, vs]) => ({ strength, violations: vs }));
}

export {
  SEVERITIES,
  shortName,
  isoDate,
  parseSliceIssue,
  parseSlicingReason,
  slicingIssueParts,
  buildDetailItems,
  buildReportModel,
  buildPackageModel,
  buildExamplesModel,
  exampleHasNoResult,
  exampleErrorCount,
  groupObligationsByStrength,
};
