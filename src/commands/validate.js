'use strict';

const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const fs = require('fs-extra');

const inquirer = require('inquirer');
const { getWorkdir, setWorkdir, loadSelectionCache, saveSelectionCache } = require('../lib/config');
const { downloadFhirPackage, resolvePackageDir, packageHasSnapshots } = require('../lib/fhirPkgTool');
const {
  findProfileByCanonical,
  findEuProfilesByType,
  findAllProfilesInPackage,
  canonicalToSlug,
} = require('../lib/profileUtils');
const { runValidator } = require('../lib/javaValidator');
const {
  isServerReady,
  serverHasCanonical,
  startValidatorServer,
  validateBatchViaServer,
} = require('../lib/javaValidatorServer');
const { generateExampleReport, appendExampleSummary, mdCell, mdText } = require('../lib/reportGen');
const {
  parsePackageSpec,
  writeErrorReport,
  prepareProfile,
  postProcessProfile,
  runExamplesForProfile,
  summarizeExamples,
  describeEuPackages,
  toolInfo,
} = require('../lib/validateCore');
const { loadPackageMapping, savePackageMapping, loadExternalMapping } = require('../lib/mappingFile');
const { ensureReady, resolveEuPackageDirs } = require('../lib/preflight');
const { CliError, EXIT, setExitCode, outcomeExitCode } = require('../lib/errors');

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Progress logger. In --json mode everything goes to stderr so stdout carries
 * only the final JSON document.
 */
function makeLogger(options) {
  return options.json
    ? (...args) => process.stderr.write(args.join(' ') + '\n')
    : (...args) => console.log(...args);
}

/** True when the user can answer prompts (TTY on stdin and stdout, not --json). */
function isInteractive(options) {
  return !options.json && !!process.stdin.isTTY && !!process.stdout.isTTY;
}

/** Writes the JSON result to --output or stdout. */
async function emitJson(options, result, log) {
  const jsonOutput = JSON.stringify(result, null, 2);
  if (options.output) {
    await fs.outputFile(options.output, jsonOutput, 'utf8');
    log(chalk.gray(`JSON result written to: ${path.resolve(options.output)}`));
  } else {
    process.stdout.write(jsonOutput + '\n');
  }
}

function applyCommonOptions(options) {
  if (options.workdir) setWorkdir(options.workdir);
  if (options.output && !options.json) {
    throw new CliError('--output requires --json.');
  }
}

/**
 * Resolves a package directory, downloading it via fhir-pkg-tool when it is
 * missing, incomplete or has no snapshots.
 */
async function ensurePackageDir(packageName, version, log) {
  const packageSpec = `${packageName}@${version}`;
  try {
    const pkgDir = await resolvePackageDir(packageName, version);
    if (!await fs.pathExists(path.join(pkgDir, 'package', 'package.json'))) {
      await fs.remove(pkgDir);
      throw new Error('incomplete package directory');
    }
    if (!await packageHasSnapshots(pkgDir)) {
      log(chalk.yellow('  Package present but missing snapshots, downloading it again via fhir-pkg-tool...'));
      await fs.remove(pkgDir);
      throw new Error('package missing snapshots');
    }
    log(chalk.gray(`  Package already present: ${pkgDir}`));
    return pkgDir;
  } catch {
    const spinner = ora(`Downloading ${packageSpec}...`).start();
    try {
      await downloadFhirPackage(packageSpec);
      spinner.succeed(`Package ${packageSpec} downloaded`);
    } catch (err) {
      spinner.fail(`Failed to download ${packageSpec}`);
      throw new CliError(
        `Package '${packageSpec}' could not be downloaded: ${err.message}\n` +
        `To find the right package, try: complies-with-eu search <canonical>`
      );
    }
    try {
      const pkgDir = await resolvePackageDir(packageName, version);
      log(chalk.gray(`  Package dir: ${pkgDir}`));
      return pkgDir;
    } catch (err) {
      throw new CliError(err.message);
    }
  }
}

/**
 * Determines which EU profiles to claim. Order: --eu-profiles > --all-counterparts >
 * interactive prompt (TTY only) > error.
 *
 * @returns {Promise<Array<{url: string, version: string|null}>>}
 */
async function selectEuProfiles({ canonical, discovered, options, log }) {
  if (options.euProfiles) {
    const specified = options.euProfiles.split(',').map(s => s.trim()).filter(Boolean);
    const discoveredVersions = new Map(discovered.map(p => [p.url, p.version]));
    log(chalk.cyan(`  ${specified.length} EU profile(s) selected via --eu-profiles`));
    return specified.map(url => ({ url, version: discoveredVersions.get(url) ?? null }));
  }
  if (discovered.length === 0) return [];
  if (options.allCounterparts) {
    log(chalk.cyan(`  All ${discovered.length} EU profile(s) selected via --all-counterparts`));
    return discovered;
  }
  if (!isInteractive(options)) {
    throw new CliError(
      'EU profile selection required, but no interactive terminal is available' +
      (options.json ? ' (--json disables prompts)' : '') + '.\n' +
      `Use --eu-profiles <url1,url2> to choose explicitly, or --all-counterparts to use all ${discovered.length} matching EU profile(s).`
    );
  }
  const cached = loadSelectionCache(canonical);
  if (cached) {
    log(chalk.gray(`  Loaded previous selection from cache (${cached.length} profile(s))`));
  }
  const { selected } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selected',
      message: 'Select the EU profiles to claim via compliesWithProfile (space = toggle, enter = confirm)',
      choices: discovered.map(p => ({
        name: p.url,
        value: p.url,
        checked: cached ? cached.includes(p.url) : true,
      })),
      pageSize: Math.min(discovered.length, 20),
    },
  ]);
  saveSelectionCache(canonical, selected);
  log(chalk.cyan(`  ${selected.length} EU profile(s) selected`));
  return discovered.filter(p => selected.includes(p.url));
}

/**
 * Runs example validation for one profile and writes/links the example report.
 * @returns {Promise<object|null>} JSON summary (see summarizeExamples) or null if no examples
 */
async function validateExamples({ pkgDir, fhirType, slug, examplesDir, euCanonicals, igIds, canonical, packageSpec, mainReportPath, debug, log }) {
  const exResult = await runExamplesForProfile({ pkgDir, fhirType, slug, examplesDir, euCanonicals, igIds, debug, log });
  if (!exResult) return summarizeExamples(null);
  try {
    await generateExampleReport({
      canonical,
      packageSpec,
      euCanonicals,
      results: exResult.exampleResults,
      reportPath: exResult.exReportPath,
    });
    if (mainReportPath) {
      await appendExampleSummary({
        mainReportPath,
        results: exResult.exampleResults,
        exReportPath: exResult.exReportPath,
      });
    }
  } catch (err) {
    log(chalk.yellow(`  Example report generation failed: ${err.message}`));
  }
  return summarizeExamples(exResult);
}

// ── validate ───────────────────────────────────────────────────────────────

async function runValidate(pkg, canonical, options = {}) {
  applyCommonOptions(options);
  const log = makeLogger(options);

  log(chalk.bold('\ncomplies-with-eu validate\n'));
  if (!options._preflightDone) await ensureReady();

  const { packageName, version } = parsePackageSpec(pkg);
  const packageSpec = `${packageName}@${version}`;

  log(chalk.cyan(`Package:   ${packageSpec}`));
  log(chalk.cyan(`Canonical: ${canonical}`));
  log('');

  // 1. Resolve package directory – download only if not already present
  let pkgDir = options.pkgDir ?? null;
  if (pkgDir) {
    log(chalk.gray(`  Package dir (pre-resolved): ${pkgDir}`));
  } else {
    pkgDir = await ensurePackageDir(packageName, version, log);
  }

  // 2. Find the profile by canonical
  let spinner = ora(`Searching for profile with canonical '${canonical}'...`).start();
  let profile;
  try {
    ({ profile } = await findProfileByCanonical(pkgDir, canonical));
    spinner.succeed(`Found profile: ${profile.name || profile.id || canonical}`);
  } catch (err) {
    spinner.fail('Profile not found');
    throw new CliError(`${err.message}\nList the profiles of the package with: complies-with-eu search ${packageSpec}`);
  }

  // 2b. If the profile has no snapshot, the package was placed in the cache by another tool
  // (e.g. the Java validator) before fhir-pkg-tool could generate snapshots. Delete and re-fetch.
  if (!profile.snapshot) {
    log(chalk.yellow(`  Profile '${canonical}' has no snapshot, downloading the package again via fhir-pkg-tool...`));
    await fs.remove(pkgDir);
    pkgDir = await ensurePackageDir(packageName, version, log);
    try {
      ({ profile } = await findProfileByCanonical(pkgDir, canonical));
    } catch (err) {
      throw new CliError(err.message);
    }
  }

  const fhirType = profile.type;
  if (!fhirType) {
    throw new CliError("Profile has no 'type' field. Cannot determine the resource type.");
  }
  log(chalk.cyan(`  ResourceType: ${fhirType}`));

  // 3. Resolve EU package directories
  const euPackageDirs = await resolveEuPackageDirs({ log });

  // 4. Collect matching EU profiles by FHIR type
  spinner = ora(`Collecting EU profiles of type '${fhirType}'...`).start();
  let discovered;
  try {
    discovered = await findEuProfilesByType(euPackageDirs, fhirType);
    spinner.succeed(`Found ${discovered.length} EU profile(s) of type '${fhirType}'`);
    for (const p of discovered) {
      log(chalk.gray(`    ${p.url}${p.version ? `|${p.version}` : ''}`));
    }
  } catch (err) {
    spinner.fail('Failed to collect EU profiles');
    throw new CliError(err.message);
  }

  // 5. Selection (--eu-profiles / --all-counterparts / prompt)
  const euProfiles = await selectEuProfiles({ canonical, discovered, options, log });
  const euCanonicals = euProfiles.map(p => p.url);

  // 6. Prepare profile (add compliesWithProfile extensions, write modified JSON, build igIds)
  spinner = ora('Preparing profile for validation...').start();
  let slug, modifiedProfilePath, igIds;
  try {
    ({ slug, modifiedProfilePath, igIds } = await prepareProfile({
      pkgDir,
      profile,
      euPackageDirs,
      euProfilesOverride: euProfiles,
    }));
    spinner.succeed(`Modified profile saved: ${modifiedProfilePath}`);
  } catch (err) {
    spinner.fail('Failed to prepare profile');
    throw new CliError(`Failed to prepare profile: ${err.message}`);
  }

  // 7. Run FHIR Java Validator
  log(chalk.bold('\nRunning FHIR Java Validator...\n'));
  let parsed, mode;
  try {
    ({ parsed, mode } = await runValidator(modifiedProfilePath, igIds, !!options.debug));
  } catch (err) {
    throw new CliError(`Validator failed: ${err.message}`);
  }

  // 8. Post-process: obligation check, constraint evaluation, report generation
  spinner = ora('Post-processing validator results...').start();
  let compliance, reportPath, obligationViolationsByEuCanonical;
  try {
    ({ compliance, reportPath, obligationViolationsByEuCanonical } = await postProcessProfile({
      pkgDir,
      profile,
      canonical,
      packageSpec,
      euPackageDirs,
      euProfiles,
      euCanonicals,
      parsed,
      slug,
      options,
    }));
    const totalOblViolations = [...obligationViolationsByEuCanonical.values()].reduce((s, v) => s + v.length, 0);
    spinner.succeed(`Post-processing complete: ${totalOblViolations} obligation violation(s), report written: ${reportPath}`);
  } catch (err) {
    spinner.fail('Post-processing failed');
    throw new CliError(`Post-processing failed: ${err.message}`);
  }

  // 9. Validate example instances (optional)
  let examples;
  if (options.examples) {
    log(chalk.bold('\n── Example Instance Validation ──\n'));
    examples = await validateExamples({
      pkgDir,
      fhirType,
      slug,
      examplesDir: path.join(getWorkdir(), 'examples', slug),
      euCanonicals,
      igIds,
      canonical,
      packageSpec,
      mainReportPath: reportPath,
      debug: !!options.debug,
      log,
    });
    if (examples.reportPath) {
      log(chalk.green(`  Examples report: ${examples.reportPath}`));
      log(chalk.bold.green(`\n  ${examples.total} example(s) validated, ${examples.passed} without errors.\n`));
    }
  }

  const nonCompliant = compliance.filter(c => !c.pass).length;
  const pass = nonCompliant === 0;

  // 10. JSON output (--json / --output). Fields are only ever added, never removed.
  if (options.json) {
    const reportMarkdown = await fs.readFile(reportPath, 'utf8').catch(() => '');
    const jsonResult = {
      compliance,
      report: reportMarkdown,
      pass,
      package: packageSpec,
      canonical,
      reportPath,
      tool: toolInfo(),
      validator: { mode, summary: parsed.summary ? parsed.summary.text : null },
      euPackages: await describeEuPackages(euPackageDirs),
      ...(options.examples ? { examples } : {}),
    };
    await emitJson(options, jsonResult, log);
  } else {
    console.log(chalk.bold.green('\nDone!\n'));
    for (const c of compliance) {
      console.log(`  ${c.pass ? chalk.green('PASS') : chalk.red('FAIL')}  ${c.euCanonical}`);
    }
  }

  log(`\n  Report: ${reportPath}\n`);
  setExitCode(outcomeExitCode({ failOnNoncompliant: options.failOnNoncompliant, nonCompliant }));
  return { compliance, pass, reportPath };
}

// ── validate-batch (todo file) ─────────────────────────────────────────────

/**
 * Batch-validates all profiles from a todo-JSON file.
 * JSON format: Array of { package, version, profiles: string[] }
 * All EU profiles are used automatically (no interactive selection).
 *
 * @param {string} jsonFile   - Absolute or relative path to the todo JSON file
 * @param {object} options    - { debug, examples, json, output, workdir, failOnNoncompliant, ... }
 */
async function runValidateBatchFile(jsonFile, options = {}) {
  applyCommonOptions(options);
  const log = makeLogger(options);
  log(chalk.bold('\ncomplies-with-eu validate-batch (todo file)\n'));
  await ensureReady();

  // ── Load the todo file ───────────────────────────────────────────────────
  let todoEntries;
  try {
    todoEntries = await fs.readJson(jsonFile);
  } catch (err) {
    throw new CliError(`Could not read todo file: ${jsonFile}\n${err.message}`);
  }
  if (!Array.isArray(todoEntries) || todoEntries.length === 0) {
    throw new CliError('The todo file must contain a non-empty JSON array of { package, version, profiles[] }.');
  }

  // Flatten into individual { packageName, version, canonical } tasks
  const tasks = [];
  for (const entry of todoEntries) {
    const packageName = entry.package;
    const version = entry.version ?? 'current';
    if (!packageName || !Array.isArray(entry.profiles)) {
      log(chalk.yellow(`  Skipped (invalid entry): ${JSON.stringify(entry)}`));
      continue;
    }
    for (const canonical of entry.profiles) {
      tasks.push({ packageName, version, canonical });
    }
  }

  if (tasks.length === 0) {
    throw new CliError('No processable profiles found in the todo file.');
  }

  log(chalk.cyan(`Processing ${tasks.length} profile(s)...\n`));

  // ── Resolve EU package directories once ──────────────────────────────────
  const euPackageDirs = await resolveEuPackageDirs({ log });

  // ── Per-task package dir cache to avoid redundant downloads ──────────────
  const pkgDirCache = new Map();

  const results = { success: 0, failed: 0, reports: [] };

  const fail = async (task, message) => {
    const { canonical, packageSpec, slug } = task;
    const reportPath = await writeErrorReport(slug, canonical, packageSpec, message);
    log(chalk.red(`  Error report: ${reportPath}`));
    results.failed++;
    results.reports.push({ canonical, packageSpec, reportPath, error: true, errorMessage: message, pass: false, compliance: [] });
  };

  for (let i = 0; i < tasks.length; i++) {
    const { packageName, version, canonical } = tasks[i];
    const packageSpec = `${packageName}@${version}`;
    const slug = canonicalToSlug(canonical);
    const task = { canonical, packageSpec, slug };
    const progressPrefix = chalk.bold.cyan(`[${i + 1}/${tasks.length}]`);

    log(`\n${progressPrefix} ${chalk.bold(packageSpec)} → ${chalk.white(canonical)}`);

    // ── Step 1: Resolve package dir ─────────────────────────────────────────
    let pkgDir = pkgDirCache.get(packageSpec) ?? null;
    if (!pkgDir) {
      try {
        pkgDir = await ensurePackageDir(packageName, version, log);
        pkgDirCache.set(packageSpec, pkgDir);
      } catch (err) {
        await fail(task, `Package ${packageSpec} could not be downloaded: ${err.message}`);
        continue;
      }
    } else {
      log(chalk.gray(`  Package (cached): ${pkgDir}`));
    }

    // ── Step 2: Find profile by canonical ──────────────────────────────────
    let profile;
    try {
      ({ profile } = await findProfileByCanonical(pkgDir, canonical));
      log(chalk.gray(`  Profile found: ${profile.name || profile.id || canonical}`));
    } catch (err) {
      await fail(task, `Profile with canonical '${canonical}' not found in package ${packageSpec}: ${err.message}`);
      continue;
    }

    // ── Step 2b: Re-download if profile has no snapshot ────────────────────
    if (!profile.snapshot) {
      log(chalk.yellow(`  Profile '${canonical}' has no snapshot, downloading the package again...`));
      await fs.remove(pkgDir);
      pkgDirCache.delete(packageSpec);
      try {
        pkgDir = await ensurePackageDir(packageName, version, log);
        pkgDirCache.set(packageSpec, pkgDir);
        ({ profile } = await findProfileByCanonical(pkgDir, canonical));
      } catch (err) {
        await fail(task, `Snapshot regeneration failed: ${err.message}`);
        continue;
      }
    }

    const fhirType = profile.type;
    if (!fhirType) {
      await fail(task, "Profile has no 'type' field. Cannot determine the resource type.");
      continue;
    }
    log(chalk.gray(`  ResourceType: ${fhirType}`));

    // ── Step 3: Collect EU profiles by type (all, no selection) ───────────
    let euProfiles;
    let euCanonicals;
    try {
      euProfiles = await findEuProfilesByType(euPackageDirs, fhirType);
      euCanonicals = euProfiles.map(p => p.url);
      log(chalk.gray(`  ${euProfiles.length} EU profile(s) of type '${fhirType}' found`));
    } catch (err) {
      await fail(task, `Error while searching EU profiles for type '${fhirType}': ${err.message}`);
      continue;
    }

    // ── Step 4: Prepare profile (add extensions, write modified, build igIds) ────
    let modifiedProfilePath, igIds;
    try {
      ({ modifiedProfilePath, igIds } = await prepareProfile({
        pkgDir,
        profile,
        euPackageDirs,
        euProfilesOverride: euProfiles,
      }));
    } catch (err) {
      await fail(task, `Profile preparation failed: ${err.message}`);
      continue;
    }

    // ── Step 5: Run FHIR Java Validator ───────────────────────────────────
    const spinner = ora('  Validating...').start();
    let parsed;
    try {
      ({ parsed } = await runValidator(modifiedProfilePath, igIds, !!options.debug));
      spinner.succeed('Validation complete');
    } catch (err) {
      spinner.fail('Validator failed');
      await fail(task, `FHIR Java Validator failed: ${err.message}`);
      continue;
    }

    // ── Step 6: Post-process (obligation, constraints, report) ────────────
    let reportPath, compliance;
    try {
      ({ reportPath, compliance } = await postProcessProfile({
        pkgDir,
        profile,
        canonical,
        packageSpec,
        euPackageDirs,
        euProfiles,
        euCanonicals,
        parsed,
        slug,
        options,
      }));
      log(chalk.green(`  Report: ${reportPath}`));
    } catch (err) {
      await fail(task, `Post-processing failed: ${err.message}`);
      continue;
    }

    const entry = { canonical, packageSpec, reportPath, error: false, pass: compliance.every(c => c.pass), compliance };
    results.success++;
    results.reports.push(entry);

    // ── Step 7 (optional): Validate examples ──────────────────────────────
    if (options.examples) {
      log(chalk.gray(`  Validating example instances of type '${fhirType}'...`));
      entry.examples = await validateExamples({
        pkgDir,
        fhirType,
        slug,
        examplesDir: path.join(getWorkdir(), 'examples', slug),
        euCanonicals,
        igIds,
        canonical,
        packageSpec,
        mainReportPath: reportPath,
        debug: !!options.debug,
        log,
      });
      if (entry.examples.reportPath) log(chalk.green(`  Examples report: ${entry.examples.reportPath}`));
    }
  }

  const nonCompliant = results.reports.filter(r => !r.error && !r.pass).length;
  const compliant = results.reports.filter(r => !r.error && r.pass).length;

  // ── Final summary ─────────────────────────────────────────────────────────
  log(chalk.bold('\n══════════════════════════════════════════'));
  log(chalk.bold('  Batch validation complete'));
  log(chalk.bold('══════════════════════════════════════════\n'));
  log(`  Total:          ${tasks.length}`);
  log(chalk.green(`  Processed:      ${results.success} (${compliant} compliant, ${nonCompliant} non-compliant)`));
  if (results.failed > 0) {
    log(chalk.red(`  Errors:         ${results.failed}`));
  }
  log('');
  for (const r of results.reports) {
    const icon = r.error ? chalk.red('ERROR') : (r.pass ? chalk.green('PASS ') : chalk.yellow('FAIL '));
    const label = r.canonical.split('/').pop().padEnd(60);
    log(`  ${icon} ${label} → ${r.reportPath}`);
  }
  log(`\n  Reports: ${getWorkdir()}\n`);

  if (options.json) {
    await emitJson(options, {
      mode: 'file',
      todoFile: path.resolve(jsonFile),
      artifactsRoot: getWorkdir(),
      pass: results.failed === 0 && nonCompliant === 0,
      summary: {
        total: tasks.length,
        success: results.success,
        failed: results.failed,
        compliant,
        nonCompliant,
        errored: results.failed,
      },
      profiles: results.reports.map(r => ({
        package: r.packageSpec,
        canonical: r.canonical,
        pass: r.pass,
        reportPath: r.reportPath,
        compliance: r.compliance || [],
        ...(r.error ? { error: r.errorMessage } : {}),
        ...(r.examples ? { examples: r.examples } : {}),
      })),
      tool: toolInfo(),
      euPackages: await describeEuPackages(euPackageDirs),
    }, log);
  }

  setExitCode(outcomeExitCode({ failOnNoncompliant: options.failOnNoncompliant, nonCompliant, errored: results.failed }));
}

// ── validate-batch (package mode) ──────────────────────────────────────────

/**
 * Discovers candidate profiles in a package, scans EU counterparts by type,
 * and resolves the EU counterpart mapping (interactive or headless).
 * Does NOT save the mapping — callers are responsible for persistence.
 *
 * @returns {Promise<{finalMapping: object, candidates: Array, euProfilesByType: Map}>}
 */
async function discoverAndResolveMapping(pkgDir, euPackageDirs, pkgWorkdir, options, log) {
  const spinner = ora('Discovering profiles in package...').start();
  let allProfiles;
  try {
    allProfiles = await findAllProfilesInPackage(pkgDir);
    spinner.succeed(`Found ${allProfiles.length} StructureDefinition(s) in package`);
  } catch (err) {
    spinner.fail('Failed to scan package');
    throw new CliError(`Failed to scan package: ${err.message}`);
  }

  let candidates = allProfiles.filter(p => p.type && (!p.kind || p.kind === 'resource'));
  if (options.type) {
    const allowedTypes = options.type.split(',').map(t => t.trim()).filter(Boolean);
    candidates = candidates.filter(p => allowedTypes.includes(p.type));
    log(chalk.cyan(`  Filtered to ${candidates.length} profile(s) by type: ${allowedTypes.join(', ')}`));
  }

  const euProfilesByType = new Map();
  for (const candidate of candidates) {
    if (!euProfilesByType.has(candidate.type)) {
      const euProfs = await findEuProfilesByType(euPackageDirs, candidate.type);
      euProfilesByType.set(candidate.type, euProfs);
    }
  }

  candidates = candidates.filter(p => (euProfilesByType.get(p.type) || []).length > 0);

  if (candidates.length === 0) {
    return { finalMapping: {}, candidates, euProfilesByType };
  }

  log(chalk.cyan(`  ${candidates.length} profile(s) with EU counterparts found\n`));

  // Resolve mapping: priority: --mapping > --all-counterparts > cached mapping.json > interactive > fail
  let finalMapping = {};

  if (options.mapping) {
    try {
      const external = await loadExternalMapping(options.mapping);
      finalMapping = external.mappings || {};
      log(chalk.cyan(`  Loaded external mapping from ${options.mapping}`));
    } catch (err) {
      throw new CliError(`Failed to load mapping file: ${err.message}`);
    }
  }

  if (!options.reselect && !options.mapping) {
    const existing = await loadPackageMapping(pkgWorkdir);
    if (existing && existing.mappings) {
      finalMapping = { ...finalMapping, ...existing.mappings };
      const covered = candidates.filter(c => finalMapping[c.url] !== undefined).length;
      log(chalk.cyan(`  Loaded existing mapping.json (covers ${covered}/${candidates.length} profiles)`));
    }
  }

  const needsPrompting = [];
  for (const candidate of candidates) {
    if (finalMapping[candidate.url] !== undefined) continue;
    if (options.allCounterparts) {
      finalMapping[candidate.url] = (euProfilesByType.get(candidate.type) || []).map(p => p.url);
      continue;
    }
    const euCandidates = euProfilesByType.get(candidate.type) || [];
    if (euCandidates.length === 1) {
      finalMapping[candidate.url] = [euCandidates[0].url];
      continue;
    }
    needsPrompting.push({ canonical: candidate.url, euCandidates });
  }

  if (needsPrompting.length > 0) {
    if (!isInteractive(options)) {
      throw new CliError(
        `${needsPrompting.length} profile(s) require EU counterpart selection, but no interactive terminal is available` +
        (options.json ? ' (--json disables prompts)' : '') + '.\n' +
        'Use --mapping <file> to provide a mapping file, or --all-counterparts to auto-select all counterparts.'
      );
    }

    log(chalk.bold(`\n${needsPrompting.length} profile(s) need EU counterpart selection:\n`));

    for (let i = 0; i < needsPrompting.length; i++) {
      const { canonical, euCandidates } = needsPrompting[i];
      const profileName = canonical.split('/').pop();
      const globalCached = loadSelectionCache(canonical);

      const { selected } = await inquirer.prompt([
        {
          type: 'checkbox',
          name: 'selected',
          message: `[${i + 1}/${needsPrompting.length}] ${profileName} → Which EU profiles?`,
          choices: euCandidates.map(p => ({
            name: `${p.url}${p.version ? `|${p.version}` : ''}`,
            value: p.url,
            checked: globalCached ? globalCached.includes(p.url) : true,
          })),
          pageSize: Math.min(euCandidates.length, 15),
        },
      ]);

      finalMapping[canonical] = selected;
      saveSelectionCache(canonical, selected);
    }
  }

  return { finalMapping, candidates, euProfilesByType };
}

/**
 * Starts (or, for an explicit --server-port, verifies and reuses) a local
 * validator server. Never reuses an unknown responder: a validator loaded with
 * other IGs would silently produce wrong verdicts.
 */
async function acquireLocalServer({ options, igIds, verifyCanonical, log }) {
  const explicit = options.serverPort || process.env.VALIDATOR_SERVER_PORT;
  if (explicit) {
    const port = parseInt(explicit, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new CliError(`Invalid server port: ${explicit}`);
    }
    if (await isServerReady(port)) {
      if (await serverHasCanonical(port, verifyCanonical)) {
        log(chalk.cyan(`  Reusing running validator server on port ${port} (verified: ${verifyCanonical} is loaded)`));
        return { port, stop: () => {} };
      }
      throw new CliError(
        `Port ${port} is already in use by another process or by a validator loaded with different IGs.\n` +
        'Stop that process, choose another --server-port, or omit --server-port to use a free port automatically.'
      );
    }
    log(chalk.cyan(`  Starting local validator server on port ${port}...`));
    return startValidatorServer({ igIds, port, debug: !!options.debug });
  }
  log(chalk.cyan('  Starting local validator server on a free port...'));
  return startValidatorServer({ igIds, debug: !!options.debug });
}

/**
 * Validates all profiles in a FHIR package that have EU counterparts.
 * Supports interactive and headless modes with persistent mapping.
 *
 * @param {string} pkgInput - Package name[@version]
 * @param {object} options  - { debug, examples, json, output, mapping, allCounterparts, reselect, type, workdir, failOnNoncompliant, serverPort }
 */
async function runValidatePackage(pkgInput, options = {}) {
  applyCommonOptions(options);
  const log = makeLogger(options);

  log(chalk.bold('\ncomplies-with-eu validate-batch (package mode)\n'));
  await ensureReady();

  // 1. Parse package spec and compute workdir
  const { packageName, version } = parsePackageSpec(pkgInput);
  const packageSpec = `${packageName}@${version}`;
  const pkgSlug = `${packageName}-${version}`.replace(/\./g, '-').replace(/@/g, '-');
  const pkgWorkdir = path.join(getWorkdir(), pkgSlug);
  const modifiedDir = path.join(pkgWorkdir, 'modified');

  await fs.ensureDir(pkgWorkdir);
  // Start from an empty modified/ directory so stale profiles from earlier runs are not validated
  await fs.emptyDir(modifiedDir);
  await fs.ensureDir(path.join(pkgWorkdir, 'examples'));

  log(chalk.cyan(`Package: ${packageSpec}`));
  log(chalk.cyan(`Workdir: ${pkgWorkdir}\n`));

  // 2. Resolve/download package
  const pkgDir = await ensurePackageDir(packageName, version, log);

  // 3. Resolve EU package directories once
  const euPackageDirs = await resolveEuPackageDirs({ log });
  const euPackagesInfo = await describeEuPackages(euPackageDirs);

  // 4. Discover candidate profiles + resolve EU counterpart mapping
  const { finalMapping, candidates, euProfilesByType } = await discoverAndResolveMapping(
    pkgDir, euPackageDirs, pkgWorkdir, options, log
  );

  const summary = { total: 0, success: 0, failed: 0, profiles: [] };

  const finish = async () => {
    const errored = summary.failed;
    const compliant = summary.profiles.filter(p => !p.error && p.pass).length;
    const nonCompliant = summary.profiles.filter(p => !p.error && !p.pass).length;

    // Package-level report
    const packageReportPath = path.join(pkgWorkdir, 'package-report.md');
    const reportLines = [
      `# Package Compliance Report: ${mdText(packageSpec)}`,
      '',
      `**Date:** ${new Date().toISOString().slice(0, 10)}`,
      `**Profiles:** ${summary.total} total, ${compliant} compliant, ${nonCompliant} non-compliant, ${errored} with errors`,
      '',
      '## Profiles',
      '',
      '| Profile | Status | Report |',
      '|---------|--------|--------|',
    ];
    for (const p of summary.profiles) {
      const status = p.error ? '⚠️ error' : (p.pass ? '✅' : '❌');
      const name = mdCell(mdText(p.canonical.split('/').pop()));
      reportLines.push(`| ${name} | ${status} | [Report](${p.slug}-report.md) |`);
    }
    reportLines.push('');
    await fs.outputFile(packageReportPath, reportLines.join('\n'), 'utf8');

    if (options.json) {
      await emitJson(options, {
        package: packageSpec,
        artifactsRoot: pkgWorkdir,
        summary: {
          total: summary.total,
          success: summary.success,
          failed: summary.failed,
          compliant,
          nonCompliant,
          errored,
        },
        profiles: summary.profiles.map(p => ({
          canonical: p.canonical,
          slug: p.slug,
          pass: p.pass,
          reportPath: path.relative(pkgWorkdir, p.reportPath),
          compliance: p.compliance || [],
          ...(p.error ? { error: p.error } : {}),
          ...(p.examples ? { examples: p.examples } : {}),
        })),
        pass: errored === 0 && nonCompliant === 0,
        packageReportPath: path.relative(pkgWorkdir, packageReportPath),
        tool: toolInfo(),
        euPackages: euPackagesInfo,
      }, log);
    }

    log(chalk.bold('\n══════════════════════════════════════════'));
    log(chalk.bold('  Package Validation Complete'));
    log(chalk.bold('══════════════════════════════════════════\n'));
    log(`  Total:          ${summary.total}`);
    log(chalk.green(`  Compliant:      ${compliant}`));
    if (nonCompliant > 0) log(chalk.yellow(`  Non-compliant:  ${nonCompliant}`));
    if (errored > 0) log(chalk.red(`  Errors:         ${errored}`));
    log(`\n  Package report: ${packageReportPath}`);
    log(`  Artifacts:      ${pkgWorkdir}\n`);

    setExitCode(outcomeExitCode({ failOnNoncompliant: options.failOnNoncompliant, nonCompliant, errored }));
  };

  if (candidates.length === 0) {
    log(chalk.yellow('\n  No profiles with EU counterparts found in this package.'));
    return finish();
  }

  // Save mapping.json
  await savePackageMapping(pkgWorkdir, packageSpec, finalMapping);
  log(chalk.green(`  Mapping saved: ${path.join(pkgWorkdir, 'mapping.json')}\n`));

  // Drop profiles with empty mapping (explicitly skipped)
  const profilesToValidate = candidates.filter(c => (finalMapping[c.url] || []).length > 0);

  const skipped = candidates.length - profilesToValidate.length;
  if (skipped > 0) {
    log(chalk.yellow(`  ${skipped} profile(s) skipped (empty mapping)\n`));
  }

  if (profilesToValidate.length === 0) {
    log(chalk.yellow('  No profiles to validate after applying mapping.'));
    return finish();
  }

  log(chalk.bold(`Validating ${profilesToValidate.length} profile(s)...\n`));
  summary.total = profilesToValidate.length;

  const recordError = async (canonical, slug, message) => {
    const reportPath = await writeErrorReport(slug, canonical, packageSpec, message, pkgWorkdir);
    summary.failed++;
    summary.profiles.push({ canonical, slug, pass: false, reportPath, error: message });
    log(chalk.red(`  ❌ ${canonical.split('/').pop()}: ${message}`));
  };

  // 5. Prepare all profiles (write modified JSONs to pkgWorkdir/modified/)
  const prepared = []; // [{ canonical, slug, fhirType, euProfiles, euCanonicals, modifiedProfilePath, igIds, profile }]

  for (const candidate of profilesToValidate) {
    const { url: canonical } = candidate;
    try {
      const { profile } = await findProfileByCanonical(pkgDir, canonical);
      const euCanonicals = finalMapping[canonical];
      const euProfiles = (euProfilesByType.get(candidate.type) || []).filter(p => euCanonicals.includes(p.url));

      const prep = await prepareProfile({
        pkgDir,
        profile,
        euPackageDirs,
        reportDir: pkgWorkdir,
        modifiedDir,
        euProfilesOverride: euProfiles,
      });

      prepared.push({
        canonical,
        slug: prep.slug,
        fhirType: prep.fhirType,
        euProfiles,
        euCanonicals,
        modifiedProfilePath: prep.modifiedProfilePath,
        igIds: prep.igIds,
        profile,
      });
    } catch (err) {
      await recordError(canonical, canonicalToSlug(canonical), `Preparation failed: ${err.message}`);
    }
  }

  if (prepared.length === 0) {
    log(chalk.red('All profiles failed during preparation.'));
    await finish();
    setExitCode(EXIT.ERROR);
    return;
  }

  log(chalk.green(`  ${prepared.length} profile(s) prepared for validation\n`));

  // 6. Validate all profiles via a local Java validator server (one JVM, one POST per profile)
  log(chalk.bold('Running FHIR Java Validator (server mode)...\n'));

  // All profiles share the same igIds (EU packages + this package)
  const igIds = prepared[0].igIds;
  let batchResults;
  let server = null;
  try {
    server = await acquireLocalServer({ options, igIds, verifyCanonical: prepared[0].canonical, log });
    log(chalk.green(`  Validator server ready on port ${server.port}\n`));
    const files = prepared.map(p => path.basename(p.modifiedProfilePath));
    ({ results: batchResults } = await validateBatchViaServer(server.port, modifiedDir, files));
    log(chalk.green('  Validator batch completed\n'));
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`Validator server failed: ${err.message}`);
  } finally {
    if (server) {
      server.stop();
      log(chalk.gray('  Validator server stopped.'));
    }
  }

  const resultMap = new Map(batchResults.map(r => [r.fileName, r]));

  // 7. Post-process each profile
  for (const prep of prepared) {
    const { canonical, slug, euProfiles, euCanonicals, profile } = prep;
    const parsed = resultMap.get(path.basename(prep.modifiedProfilePath));

    if (!parsed || !parsed.summary) {
      await recordError(canonical, slug, `No validator result for this profile${parsed && parsed.error ? ` (${parsed.error})` : ''}`);
      continue;
    }

    try {
      const { compliance, reportPath } = await postProcessProfile({
        pkgDir,
        profile,
        canonical,
        packageSpec,
        euPackageDirs,
        euProfiles,
        euCanonicals,
        parsed,
        slug,
        reportDir: pkgWorkdir,
        options,
      });

      const pass = compliance.every(c => c.pass);
      summary.success++;
      summary.profiles.push({ canonical, slug, pass, reportPath, compliance });
      log(`  ${pass ? chalk.green('✅') : chalk.yellow('⚠️')} ${canonical.split('/').pop()}`);
    } catch (err) {
      await recordError(canonical, slug, `Post-processing failed: ${err.message}`);
    }
  }

  // 8. (Optional) Examples (before the JSON output, so --json --examples includes them)
  if (options.examples) {
    log(chalk.bold('\n── Example Instance Validation ──\n'));

    for (const prep of prepared) {
      const { canonical, slug, fhirType, euCanonicals, igIds: prepIgIds } = prep;
      const entry = summary.profiles.find(p => p.canonical === canonical);
      log(chalk.gray(`  ${canonical.split('/').pop()}...`));

      const examples = await validateExamples({
        pkgDir,
        fhirType,
        slug,
        examplesDir: path.join(pkgWorkdir, 'examples', slug),
        euCanonicals,
        igIds: prepIgIds,
        canonical,
        packageSpec,
        mainReportPath: entry && !entry.error ? entry.reportPath : null,
        debug: !!options.debug,
        log,
      });
      if (entry) entry.examples = examples;
      if (examples.total > 0) log(chalk.green(`    ${examples.total} example(s) validated, ${examples.passed} without errors`));
    }
  }

  return finish();
}

module.exports = {
  runValidate,
  runValidateBatchFile,
  runValidatePackage,
  // exported for tests
  selectEuProfiles,
  isInteractive,
};
