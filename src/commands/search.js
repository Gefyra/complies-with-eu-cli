'use strict';

const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');

const { loadAllSelectionCaches, setWorkdir } = require('../lib/config');
const { downloadFhirPackage, resolvePackageDir } = require('../lib/fhirPkgTool');
const { ensureReady, resolveEuPackageDirs } = require('../lib/preflight');
const { CliError } = require('../lib/errors');
const { findAllProfilesInPackage, findEuProfilesByType } = require('../lib/profileUtils');
const { runValidate } = require('./validate');
const { resolveCanonicalOnSimplifier } = require('../lib/simplifierResolve');
const { parsePackageSpec } = require('../lib/validateCore');

/** Options passed through from search to validate. */
function validateOptions(options, extra = {}) {
  return {
    debug: options.debug,
    examples: options.examples,
    json: options.json,
    output: options.output,
    workdir: options.workdir,
    euProfiles: options.euProfiles,
    allCounterparts: options.allCounterparts,
    failOnNoncompliant: options.failOnNoncompliant,
    _preflightDone: true,
    ...extra,
  };
}

/** Progress output; stderr with --json so stdout carries only the JSON result. */
function makeLog(options) {
  return options.json ? (...a) => process.stderr.write(a.join(' ') + '\n') : (...a) => console.log(...a);
}

/** Prompts render on stderr with --json so stdout carries only the JSON result. */
function promptFor(options) {
  return options.json ? inquirer.createPromptModule({ output: process.stderr }) : inquirer.prompt;
}

/** search picks the profile/package interactively; refuse early without a terminal. */
function requireInteractive() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      'search is interactive and needs a terminal.\n' +
      'In scripts and CI use: complies-with-eu validate <package[@version]> <canonical> --eu-profiles <urls> (or --all-counterparts)'
    );
  }
}

/**
 * When the user passes a canonical URL instead of a package name,
 * query Simplifier.net to find packages containing that canonical,
 * let the user pick one, then run validate directly.
 */
async function runSearchByCanonical(canonical, options = {}) {
  const log = makeLog(options);
  log(chalk.bold('\ncomplies-with-eu search (by canonical)\n'));
  log(chalk.cyan(`Canonical: ${canonical}\n`));

  const spinner = ora('Resolving canonical on Simplifier.net...').start();
  let results;
  try {
    results = await resolveCanonicalOnSimplifier(canonical);
    spinner.succeed(`Found ${results.length} package(s) containing this canonical`);
  } catch (err) {
    spinner.fail('Failed to query Simplifier.net');
    throw new CliError(`Failed to query Simplifier.net: ${err.message}`);
  }

  if (results.length === 0) {
    log(chalk.yellow('\n  No packages found for this canonical on Simplifier.net.'));
    return;
  }

  // Sort: exact canonical matches first
  results.sort((a, b) => {
    const aExact = a.matchType === 'claimed canonical' ? 0 : 1;
    const bExact = b.matchType === 'claimed canonical' ? 0 : 1;
    return aExact - bExact;
  });

  log('');
  const choices = results.map(r => ({
    name: `${chalk.cyan(r.packageId.padEnd(50))}  ${chalk.gray(r.matchType)}`,
    value: r.packageId,
    short: r.packageId,
  }));
  choices.push(new inquirer.Separator());
  choices.push({ name: chalk.gray('Cancel'), value: null });

  const { selectedPkg } = await promptFor(options)([
    {
      type: 'list',
      name: 'selectedPkg',
      message: 'Select the package to use:',
      choices,
      pageSize: Math.min(results.length + 2, 20),
    },
  ]);

  if (!selectedPkg) {
    log(chalk.yellow('Cancelled.'));
    return;
  }

  log('');
  await runValidate(selectedPkg, canonical, validateOptions(options));
}

async function runSearch(pkg, options = {}) {
  const log = makeLog(options);
  if (options.workdir) setWorkdir(options.workdir);
  requireInteractive();
  await ensureReady();
  // If the argument looks like a canonical URL, use the Simplifier resolve flow
  if (pkg.startsWith('http://') || pkg.startsWith('https://')) {
    return runSearchByCanonical(pkg, options);
  }

  log(chalk.bold('\ncomplies-with-eu search\n'));

  const { packageName, version } = parsePackageSpec(pkg);
  const packageSpec = `${packageName}@${version}`;

  log(chalk.cyan(`Package: ${packageSpec}`));
  if (options.type) log(chalk.cyan(`Type filter: ${options.type}`));
  log('');

  // 1. Resolve/download package
  let pkgDir;
  let spinner;
  try {
    pkgDir = await resolvePackageDir(packageName, version);
    log(chalk.gray(`  Package already present: ${pkgDir}`));
  } catch {
    spinner = ora(`Downloading ${packageSpec}...`).start();
    try {
      await downloadFhirPackage(packageSpec);
      spinner.succeed(`Package ${packageSpec} downloaded`);
    } catch (err) {
      spinner.fail(`Failed to download ${packageSpec}`);
      throw new CliError(`Package '${packageSpec}' could not be downloaded: ${err.message}`);
    }
    try {
      pkgDir = await resolvePackageDir(packageName, version);
      log(chalk.gray(`  Package dir: ${pkgDir}`));
    } catch (err) {
      throw new CliError(err.message);
    }
  }

  // 2. Find all profiles in package
  spinner = ora('Scanning package for profiles...').start();
  let allProfiles;
  try {
    allProfiles = await findAllProfilesInPackage(pkgDir);
    spinner.succeed(`Found ${allProfiles.length} profile(s) in package`);
  } catch (err) {
    spinner.fail('Failed to scan package');
    throw new CliError(err.message);
  }

  // 3. Exclude extensions and data type profiles – keep only resource profiles
  allProfiles = allProfiles.filter(p => p.kind === 'resource');

  // 4. Apply --type filter (comma-separated, case-insensitive)
  if (options.type) {
    const typeFilter = options.type.split(',').map(t => t.trim().toLowerCase());
    allProfiles = allProfiles.filter(p => typeFilter.includes((p.type || '').toLowerCase()));
  }

  // 5. Resolve EU package dirs
  const euPackageDirs = await resolveEuPackageDirs({ strict: false });

  // 5. Keep only profiles whose FHIR type has at least one EU counterpart
  spinner = ora('Checking for EU counterparts...').start();
  const uniqueTypes = [...new Set(allProfiles.map(p => p.type).filter(Boolean))];
  const typesWithEu = new Set();
  for (const fhirType of uniqueTypes) {
    const euProfiles = await findEuProfilesByType(euPackageDirs, fhirType);
    if (euProfiles.length > 0) typesWithEu.add(fhirType);
  }
  const filteredProfiles = allProfiles.filter(p => typesWithEu.has(p.type));
  spinner.succeed(`${filteredProfiles.length} profile(s) with EU counterparts`);

  if (filteredProfiles.length === 0) {
    log(chalk.yellow('\n  No profiles with EU counterparts found.'));
    return;
  }

  // 6. Build interactive list
  filteredProfiles.sort((a, b) => {
    const aExt = a.type === 'Extension';
    const bExt = b.type === 'Extension';
    if (aExt !== bExt) return aExt ? 1 : -1;
    return (a.type || '').localeCompare(b.type || '') || (a.name || '').localeCompare(b.name || '');
  });

  const cachedCanonicals = new Set(Object.keys(loadAllSelectionCaches()));
  const maxTypeLen = Math.max(...filteredProfiles.map(p => (p.type || '').length));
  const choices = filteredProfiles.map(p => {
    const cached = cachedCanonicals.has(p.url);
    const label = p.name || p.id || p.url;
    return {
      name: `${chalk.gray((p.type || '').padEnd(maxTypeLen))}  ${label}${cached ? chalk.green('  ✓') : ''}`,
      value: p.url,
      short: label,
    };
  });

  log('');
  const { canonical } = await promptFor(options)([
    {
      type: 'list',
      name: 'canonical',
      message: 'Select profile to validate (Enter to confirm):',
      choices,
      pageSize: Math.min(filteredProfiles.length, 20),
    },
  ]);

  log('');
  await runValidate(pkg, canonical, validateOptions(options, { pkgDir }));
}

module.exports = { runSearch };
