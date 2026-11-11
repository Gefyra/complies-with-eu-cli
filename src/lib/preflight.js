'use strict';

const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const {
  loadEuPackages,
  loadToolsManifest,
  getValidatorJar,
  getFhirPkgToolJar,
} = require('./config');
const { ensureJava, requiredJavaMajor } = require('./javaCheck');
const { resolvePackageDir, packageHasSnapshots, downloadFhirPackage } = require('./fhirPkgTool');
const { CliError } = require('./errors');

const stderrLog = (...args) => process.stderr.write(args.join(' ') + '\n');

/**
 * Lists what `init` should have installed but is missing (pure-ish; no Java needed).
 * @returns {Promise<string[]>} e.g. ['validator_cli.jar', 'hl7.fhir.eu.hdr@1.0.0']
 */
async function findMissingInitArtifacts({ tools = true, euPackages = true } = {}) {
  const missing = [];
  if (tools) {
    for (const jar of [getValidatorJar(), getFhirPkgToolJar()]) {
      if (!await fs.pathExists(jar)) missing.push(path.basename(jar));
    }
  }
  if (euPackages) {
    for (const pkg of loadEuPackages()) {
      try {
        await resolvePackageDir(pkg.packageName, pkg.version);
      } catch {
        missing.push(`${pkg.packageName}@${pkg.version}`);
      }
    }
  }
  return missing;
}

/**
 * Checks the prerequisites of a command and fails with an actionable CliError:
 * Java (version from tools.json) and the artifacts installed by `init`.
 *
 * @param {object}   [opts]
 * @param {boolean}  [opts.java=true]
 * @param {boolean}  [opts.tools=true]
 * @param {boolean}  [opts.euPackages=true]
 * @param {Function} [opts.warn]
 */
async function ensureReady({ java = true, tools = true, euPackages = true, warn = stderrLog } = {}) {
  if (java) ensureJava(requiredJavaMajor(loadToolsManifest()), { warn: (m) => warn(chalk.yellow(m)) });
  const missing = await findMissingInitArtifacts({ tools, euPackages });
  if (missing.length > 0) {
    throw new CliError(
      `complies-with-eu is not initialised (missing: ${missing.join(', ')}).\n` +
      'Run: complies-with-eu init'
    );
  }
}

/**
 * Resolves the directories of all EU packages from eu-packages.json. Packages
 * without snapshots are re-downloaded once.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.log]
 * @param {boolean}  [opts.strict=true] - Throw if an EU package cannot be resolved (otherwise warn)
 * @returns {Promise<string[]>}
 */
async function resolveEuPackageDirs({ log = stderrLog, strict = true } = {}) {
  const dirs = [];
  for (const euPkg of loadEuPackages()) {
    const spec = `${euPkg.packageName}@${euPkg.version}`;
    try {
      let dir = await resolvePackageDir(euPkg.packageName, euPkg.version);
      if (!await packageHasSnapshots(dir)) {
        log(chalk.yellow(`  EU package ${spec} has no snapshots, downloading it again...`));
        await fs.remove(dir);
        await downloadFhirPackage(spec);
        dir = await resolvePackageDir(euPkg.packageName, euPkg.version);
      }
      dirs.push(dir);
    } catch (err) {
      if (strict) {
        throw new CliError(`EU package ${spec} is not available: ${err.message}\nRun: complies-with-eu init`);
      }
      log(chalk.yellow(`  Warning: EU package ${spec} not found: ${err.message}`));
    }
  }
  return dirs;
}

module.exports = { findMissingInitArtifacts, ensureReady, resolveEuPackageDirs };
