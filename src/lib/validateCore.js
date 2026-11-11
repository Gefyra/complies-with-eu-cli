'use strict';

const path = require('path');
const chalk = require('chalk');
const fs = require('fs-extra');
const { getWorkdir, getPackageInfo, getValidatorJar, getToolsDir } = require('./config');
const {
  findEuProfilesByType,
  addCompliesWithExtensions,
  canonicalToSlug,
  findExamplesInPackage,
  addMetaProfileClaims,
} = require('./profileUtils');
const { runValidatorBatch } = require('./javaValidator');
const { resolvePackageId, resolvePackageDependencyDirs } = require('./fhirPkgTool');
const { generateReport, mdCode, mdText, exampleErrorCount } = require('./reportGen');
const { checkObligations } = require('./obligationCheck');
const { evaluateExistsOrConstraints, loadEuSds } = require('./constraintCheck');
const { readInstalledVersionsSync } = require('./toolDownloader');

const stderrLog = (...args) => process.stderr.write(args.join(' ') + '\n');

/**
 * Parses "packageName[@version]" (or "packageName#version") into { packageName, version }.
 * Defaults to version "current" if not specified.
 */
function parsePackageSpec(input) {
  const sepIdx = Math.max(input.lastIndexOf('@'), input.lastIndexOf('#'));
  // A leading '@' (npm-style scope) is not a version separator
  if (sepIdx <= 0) return { packageName: input, version: 'current' };
  return {
    packageName: input.slice(0, sepIdx),
    version: input.slice(sepIdx + 1) || 'current',
  };
}

/**
 * Builds the Markdown of an error report (pure, for tests).
 */
function buildErrorReport(canonical, packageSpec, message, date = new Date()) {
  return [
    `# Compliance Report: ${mdText(canonical.split('/').pop())} — ❌ ERROR`,
    '',
    `**Profile:** ${mdCode(canonical)}`,
    `**Package:** ${mdCode(packageSpec)} | **Date:** ${date.toISOString().slice(0, 10)}`,
    '',
    '## Processing error',
    '',
    `> ⚠️ ${mdText(message).replace(/\r?\n/g, '\n> ')}`,
    '',
    '_This profile could not be validated. Check the inputs and make sure the package can be downloaded._',
    '',
  ].join('\n');
}

/**
 * Writes an error report Markdown file for a profile that could not be processed.
 *
 * @param {string} slug       - Filename slug derived from the canonical
 * @param {string} canonical  - The profile canonical URL
 * @param {string} packageSpec - e.g. "kbv.basis@1.8.0"
 * @param {string} message    - Human-readable error description
 * @param {string} reportDir  - Directory where the report should be written (defaults to getWorkdir())
 */
async function writeErrorReport(slug, canonical, packageSpec, message, reportDir = null) {
  const targetDir = reportDir ?? getWorkdir();
  const reportPath = path.join(targetDir, `${slug}-report.md`);
  await fs.ensureDir(targetDir);
  await fs.outputFile(reportPath, buildErrorReport(canonical, packageSpec, message), 'utf8');
  return reportPath;
}

/**
 * Prepares a profile for validation: collects EU profiles, adds compliesWithProfile extensions,
 * writes modified JSON, and builds igIds array.
 *
 * @param {object} params
 * @param {string} params.pkgDir - Root of the resolved FHIR package
 * @param {object} params.profile - The profile JSON object
 * @param {string[]} params.euPackageDirs - Array of EU package directories
 * @param {string} params.modifiedDir - Directory for modified profiles (defaults to getWorkdir())
 * @param {Array<{url: string, version: string|null}>} params.euProfilesOverride - Optional: skip findEuProfilesByType and use these
 * @returns {Promise<{slug: string, fhirType: string, euProfiles: Array, euCanonicals: string[], modifiedProfilePath: string, igIds: string[]}>}
 */
async function prepareProfile({
  pkgDir,
  profile,
  euPackageDirs,
  modifiedDir = null,
  euProfilesOverride = null,
}) {
  const canonical = profile.url;
  const fhirType = profile.type;
  const slug = canonicalToSlug(canonical);

  const targetModifiedDir = modifiedDir ?? getWorkdir();

  // Collect EU profiles
  let euProfiles;
  let euCanonicals;
  if (euProfilesOverride) {
    euProfiles = euProfilesOverride;
    euCanonicals = euProfiles.map(p => p.url);
  } else {
    euProfiles = await findEuProfilesByType(euPackageDirs, fhirType);
    euCanonicals = euProfiles.map(p => p.url);
  }

  // Add compliesWithProfile extensions
  const modifiedProfile = addCompliesWithExtensions(profile, euCanonicals);
  await fs.ensureDir(targetModifiedDir);
  const modifiedProfilePath = path.join(targetModifiedDir, `${slug}-modified.json`);
  await fs.writeJson(modifiedProfilePath, modifiedProfile, { spaces: 2 });

  // Build igIds: EU packages + transitive deps of the user package + user package itself
  const euIgIds = await Promise.all(euPackageDirs.map(dir => resolvePackageId(dir)));
  const depDirs = await resolvePackageDependencyDirs(pkgDir, euPackageDirs);
  const igIds = [...euIgIds, ...depDirs, pkgDir];

  return { slug, fhirType, euProfiles, euCanonicals, modifiedProfilePath, igIds };
}

/**
 * Extracts claimedCanonical → detail lines from SD_EXTENSION_COMPLIES_WITH_ERROR issues.
 */
function collectNonCompliant(issues) {
  const m = new Map();
  for (const issue of issues.filter(i => i.msgId === 'SD_EXTENSION_COMPLIES_WITH_ERROR')) {
    const match = issue.message.match(/claimed profile '([^']+)'/);
    if (match) m.set(match[1], issue.details);
  }
  return m;
}

/**
 * Post-processes validator output: runs obligation check, constraint evaluation,
 * and generates the Markdown report.
 *
 * Throws when `parsed.summary` is missing: no validator result must never be
 * reported as "compliant".
 *
 * @param {object} params
 * @param {string} params.pkgDir - Root of the resolved FHIR package
 * @param {object} params.profile - The profile JSON object
 * @param {string} params.canonical - Profile canonical URL
 * @param {string} params.packageSpec - e.g. "kbv.basis@1.8.0"
 * @param {string[]} params.euPackageDirs - Array of EU package directories
 * @param {Array<{url: string, version: string|null}>} params.euProfiles - EU profiles used
 * @param {string[]} params.euCanonicals - EU canonical URLs
 * @param {object} params.parsed - Parsed validator output ({ summary, issues })
 * @param {string} params.slug - Filename slug
 * @param {string} params.reportDir - Directory for reports (defaults to getWorkdir())
 * @param {object} params.options - Additional options (e.g. { debug })
 * @returns {Promise<{compliance: Array, reportPath: string, obligationViolationsByEuCanonical: Map, filteredNonCompliantMap: Map, autoSatisfiedConstraints: Array}>}
 */
async function postProcessProfile({
  pkgDir,
  profile,
  canonical,
  packageSpec,
  euPackageDirs,
  euProfiles,
  euCanonicals,
  parsed,
  slug,
  reportDir = null,
  options = {}, // eslint-disable-line no-unused-vars
}) {
  if (!parsed || !parsed.summary || !Array.isArray(parsed.issues)) {
    throw new Error('The FHIR validator returned no result summary for this profile (crash or unexpected output); it cannot be treated as compliant.');
  }
  const targetReportDir = reportDir ?? getWorkdir();

  // Obligation check
  const obligationViolationsByEuCanonical = new Map();
  for (const euCanonical of euCanonicals) {
    try {
      const violations = await checkObligations(pkgDir, canonical, euPackageDirs, euCanonical);
      if (violations.length > 0) obligationViolationsByEuCanonical.set(euCanonical, violations);
    } catch {
      // non-fatal
    }
  }

  // Evaluate exists()-or constraints
  let filteredNonCompliantMap;
  let autoSatisfiedConstraints = [];
  try {
    const rawNonCompliantMap = collectNonCompliant(parsed.issues);
    const euSdByCanonical = await loadEuSds(euPackageDirs, euCanonicals);
    ({ filteredMap: filteredNonCompliantMap, satisfied: autoSatisfiedConstraints } =
      evaluateExistsOrConstraints({ inputSd: profile, euSdByCanonical, nonCompliantMap: rawNonCompliantMap }));
  } catch {
    // non-fatal
    filteredNonCompliantMap = undefined;
    autoSatisfiedConstraints = [];
  }

  // Generate report
  const reportPath = path.join(targetReportDir, `${slug}-report.md`);
  await fs.ensureDir(targetReportDir);
  await generateReport({
    canonical,
    packageSpec,
    euProfiles,
    euCanonicals,
    parsed,
    reportPath,
    obligationViolationsByEuCanonical,
    filteredNonCompliantMap,
    autoSatisfiedConstraints,
  });

  // Derive compliance
  const nonCompliantSet = new Set((filteredNonCompliantMap ?? collectNonCompliant(parsed.issues)).keys());
  const compliance = euProfiles.map(p => ({
    euCanonical: p.version ? `${p.url}|${p.version}` : p.url,
    pass: !nonCompliantSet.has(p.url) && !obligationViolationsByEuCanonical.has(p.url),
  }));

  return {
    compliance,
    reportPath,
    obligationViolationsByEuCanonical,
    filteredNonCompliantMap,
    autoSatisfiedConstraints,
  };
}

/**
 * Validates example instances for a profile.
 *
 * @param {object} params
 * @param {string} params.pkgDir - Root of the resolved FHIR package
 * @param {string} params.fhirType - FHIR resource type
 * @param {string} params.slug - Filename slug
 * @param {string} params.examplesDir - Directory for example artifacts
 * @param {string[]} params.euCanonicals - EU canonical URLs
 * @param {string[]} params.igIds - IG identifiers for the validator
 * @param {boolean} params.debug - Debug flag
 * @param {Function} [params.log] - Progress logger (default: stderr)
 * @returns {Promise<{exampleResults: Array, exReportPath: string}|null>}
 */
async function runExamplesForProfile({
  pkgDir,
  fhirType,
  slug,
  examplesDir,
  euCanonicals,
  igIds,
  debug = false,
  log = stderrLog,
}) {
  let examples;
  try {
    examples = await findExamplesInPackage(pkgDir, fhirType);
  } catch (err) {
    log(chalk.yellow(`  Example search failed: ${err.message}`));
    return null;
  }

  if (examples.length === 0) {
    log(chalk.gray('  No example instances found, skipped.'));
    return null;
  }

  // Start from an empty directory so stale files from earlier runs are not validated
  await fs.emptyDir(examplesDir);

  // Write modified examples
  const exampleFileNames = [];
  for (const { json, fileName } of examples) {
    const modified = addMetaProfileClaims(json, euCanonicals);
    const outPath = path.join(examplesDir, fileName);
    await fs.writeJson(outPath, modified, { spaces: 2 });
    exampleFileNames.push(fileName);
  }

  // Validate batch
  const resolvePath = path.join(pkgDir, 'package');
  const resolveArgs = ['-resolution-context', resolvePath];
  let batchResults;
  let batchError = null;
  try {
    ({ results: batchResults } = await runValidatorBatch(examplesDir, igIds, debug, resolveArgs));
  } catch (err) {
    log(chalk.red(`Example validation failed: ${err.message}`));
    batchResults = [];
    batchError = err.message;
  }

  // Map results; a missing result is kept as summary:null and reported as failed
  const resultMap = new Map(batchResults.map(r => [r.fileName, r]));
  const exampleResults = exampleFileNames.map(fn => ({
    fileName: fn,
    parsed: resultMap.get(fn) ?? { summary: null, issues: [], error: batchError || 'No validator result for this file' },
  }));

  const exReportPath = path.join(examplesDir, `${slug}-examples-report.md`);
  return { exampleResults, exReportPath };
}

/**
 * Converts example results into the JSON shape used by --json.
 */
function summarizeExamples(exResult) {
  if (!exResult) return { reportPath: null, total: 0, passed: 0, results: [] };
  const results = exResult.exampleResults.map(({ fileName, parsed }) => {
    const errors = exampleErrorCount(parsed);
    return {
      fileName,
      pass: errors === 0,
      errors,
      warnings: ((parsed && parsed.issues) || []).filter(i => i.severity === 'warning').length,
      summary: parsed && parsed.summary ? parsed.summary.text : null,
      ...(parsed && parsed.error ? { error: parsed.error } : {}),
    };
  });
  return {
    reportPath: exResult.exReportPath,
    total: results.length,
    passed: results.filter(r => r.pass).length,
    results,
  };
}

/**
 * Returns [{ packageName, version }] for resolved EU package directories (the
 * concrete version from package.json, also when eu-packages.json says "current").
 */
async function describeEuPackages(euPackageDirs) {
  const ids = await Promise.all(euPackageDirs.map(dir => resolvePackageId(dir)));
  return ids.map((id) => {
    const idx = id.indexOf('#');
    return idx >= 0
      ? { packageName: id.slice(0, idx), version: id.slice(idx + 1) }
      : { packageName: id, version: null };
  });
}

/**
 * Metadata added to every --json result: tool name/version and the local
 * validator version (if known).
 */
function toolInfo() {
  const { name, version } = getPackageInfo();
  let validatorVersion = null;
  try {
    const installed = readInstalledVersionsSync(getToolsDir());
    validatorVersion = installed[path.basename(getValidatorJar())]?.version ?? null;
  } catch {
    // unknown
  }
  return { name, version, validatorVersion };
}

module.exports = {
  parsePackageSpec,
  buildErrorReport,
  writeErrorReport,
  prepareProfile,
  postProcessProfile,
  runExamplesForProfile,
  summarizeExamples,
  describeEuPackages,
  toolInfo,
  collectNonCompliant,
};
