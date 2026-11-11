'use strict';

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const { getFhirPkgToolJar } = require('./config');
const { getJavaCommand } = require('./javaCheck');
const { track } = require('./processRegistry');

/**
 * Returns the default FHIR packages directory (~/.fhir/packages).
 */
function getFhirPackagesDir() {
  return path.join(os.homedir(), '.fhir', 'packages');
}

async function requirePkgToolJar() {
  const jar = getFhirPkgToolJar();
  if (!await fs.pathExists(jar)) {
    throw new Error(`fhir-pkg-tool.jar not found at ${jar}. Run: complies-with-eu init`);
  }
  return jar;
}

/**
 * Runs fhir-pkg-tool to download a FHIR package.
 * @param {string} packageSpec - e.g. "hl7.fhir.eu.base@current"
 */
async function downloadFhirPackage(packageSpec) {
  const jar = await requirePkgToolJar();
  return runJar(jar, ['-p', packageSpec], [packageSpec]);
}

/**
 * Runs multiple packages at once.
 * @param {Array<{packageName: string, version: string}>} packages
 */
async function downloadFhirPackages(packages) {
  const jar = await requirePkgToolJar();
  const args = [];
  const specs = [];
  for (const pkg of packages) {
    const spec = `${pkg.packageName}@${pkg.version}`;
    specs.push(spec);
    args.push('-p', spec);
  }
  return runJar(jar, args, specs);
}

/**
 * Compares two version strings ("1.10.0" > "1.9.0", "2.0.0" > "2.0.0-ballot").
 * Non-numeric versions (e.g. "current", "dev") sort after numeric ones.
 */
function compareVersions(a, b) {
  const split = (v) => {
    const [main, ...pre] = String(v).split('-');
    return { nums: main.split('.').map(n => (/^\d+$/.test(n) ? parseInt(n, 10) : NaN)), pre: pre.join('-') };
  };
  const va = split(a);
  const vb = split(b);
  const aNum = va.nums.every(Number.isFinite);
  const bNum = vb.nums.every(Number.isFinite);
  if (aNum !== bNum) return aNum ? -1 : 1;
  if (!aNum) return String(a).localeCompare(String(b));
  const len = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (va.nums[i] || 0) - (vb.nums[i] || 0);
    if (d !== 0) return d;
  }
  if (va.pre === vb.pre) return 0;
  if (!va.pre) return 1; // release > pre-release
  if (!vb.pre) return -1;
  return va.pre.localeCompare(vb.pre);
}

/**
 * Resolves the actual directory of a downloaded FHIR package.
 * fhir-pkg-tool stores packages at ~/.fhir/packages/<name>#<version>/
 * When version is "current", the actual stored version may differ.
 * This function returns the best matching directory.
 */
async function resolvePackageDir(packageName, version) {
  const packagesDir = getFhirPackagesDir();
  if (!await fs.pathExists(packagesDir)) {
    throw new Error(`FHIR packages directory not found: ${packagesDir}`);
  }
  const entries = await fs.readdir(packagesDir);

  // Exact match first: <name>#<version> (case-insensitive)
  const exactKey = `${packageName}#${version}`;
  const exactMatch = entries.find(e => e.toLowerCase() === exactKey.toLowerCase());
  if (exactMatch) {
    return path.join(packagesDir, exactMatch);
  }

  // Prefix match only for "current" – a concrete version that isn't cached must be downloaded fresh (case-insensitive)
  if (version === 'current') {
    const prefix = `${packageName}#`.toLowerCase();
    const matches = entries
      .filter(e => e.toLowerCase().startsWith(prefix))
      .sort((x, y) => compareVersions(x.slice(prefix.length), y.slice(prefix.length)));
    if (matches.length > 0) {
      return path.join(packagesDir, matches[matches.length - 1]);
    }
  }

  throw new Error(
    `Package '${packageName}#${version}' not found in ${packagesDir}. ` +
    `Make sure the package was downloaded successfully.`
  );
}

/**
 * Returns true if the package directory either contains no StructureDefinitions
 * at all (e.g. pure terminology packages) OR if at least one SD has a snapshot.
 * Returns false when SDs are present but none of them have a snapshot – which
 * indicates the fhir-pkg-tool did not run yet (package was placed into the cache
 * by another tool such as the Java validator).
 *
 * Only inspects up to MAX_CHECK files to keep startup overhead low.
 */
async function packageHasSnapshots(pkgDir) {
  const MAX_CHECK = 10;
  const packageSubdir = path.join(pkgDir, 'package');
  const searchDir = await fs.pathExists(packageSubdir) ? packageSubdir : pkgDir;
  let files;
  try {
    files = (await fs.readdir(searchDir))
      .filter(f => f.startsWith('StructureDefinition-') && f.endsWith('.json'))
      .slice(0, MAX_CHECK);
  } catch {
    return true; // can't check → assume OK
  }
  if (files.length === 0) return true; // no SDs → nothing to check

  for (const file of files) {
    try {
      const sd = await fs.readJson(path.join(searchDir, file));
      if (sd.snapshot) return true;
    } catch {
      // skip unreadable file
    }
  }
  return false; // found SDs but none had a snapshot
}

/**
 * Reads the package/package.json inside a resolved package directory and
 * returns the concrete "name#version" identifier (e.g. "hl7.fhir.eu.base#1.0.0").
 * Falls back to the directory basename if the metadata cannot be read.
 */
async function resolvePackageId(pkgDir) {
  const metaPath = path.join(pkgDir, 'package', 'package.json');
  try {
    const meta = await fs.readJson(metaPath);
    if (meta.name && meta.version) {
      return `${meta.name}#${meta.version}`;
    }
  } catch {
    // fall through
  }
  return path.basename(pkgDir);
}

/**
 * Runs a JAR with Java. Child output goes to stderr so stdout stays clean
 * for --json output.
 */
function runJar(jar, args, specs = []) {
  return new Promise((resolve, reject) => {
    const userHome = os.homedir();
    const jvmArgs = [`-Duser.home=${userHome}`, '-jar', jar, ...args];
    process.stderr.write(chalk.gray(`  java -jar ${path.basename(jar)} ${args.join(' ')}\n`));
    const proc = track(spawn(getJavaCommand(), jvmArgs, { stdio: ['ignore', 2, 2], windowsHide: true }));
    proc.on('close', (code) => {
      if (code !== 0) {
        const what = specs.length ? ` while fetching ${specs.join(', ')}` : '';
        reject(new Error(
          `fhir-pkg-tool exited with code ${code}${what}. ` +
          'Check the package name and version (https://packages.fhir.org or https://simplifier.net/packages) ' +
          'and your network connection; the tool output above has details.'
        ));
      } else {
        resolve();
      }
    });
    proc.on('error', (err) => reject(new Error(`Could not start Java for fhir-pkg-tool: ${err.message}`)));
  });
}

/**
 * Reads the declared dependencies of a FHIR package from its package/package.json.
 * Skips hl7.fhir.r4.core — always loaded via -version 4.0.1.
 */
async function readPackageDependencies(pkgDir) {
  try {
    const meta = await fs.readJson(path.join(pkgDir, 'package', 'package.json'));
    const deps = meta.dependencies || {};
    return Object.entries(deps)
      .filter(([name]) => name !== 'hl7.fhir.r4.core')
      .map(([name, version]) => ({ name, version }));
  } catch {
    return [];
  }
}

/**
 * Resolves the direct dependencies of a FHIR package that are present in the
 * local package cache (~/.fhir/packages).
 * Returns absolute directory paths, excluding packages already covered by `excludeDirs`.
 */
async function resolvePackageDependencyDirs(rootPkgDir, excludeDirs = []) {
  const excludeNames = new Set(
    await Promise.all(
      excludeDirs.map(async (d) => {
        try {
          const meta = await fs.readJson(path.join(d, 'package', 'package.json'));
          return meta.name || path.basename(d).split('#')[0];
        } catch {
          return path.basename(d).split('#')[0];
        }
      })
    )
  );

  const result = [];
  for (const { name, version } of await readPackageDependencies(rootPkgDir)) {
    if (excludeNames.has(name)) continue;
    try {
      result.push(await resolvePackageDir(name, version));
    } catch {
      // Not in local cache — validator resolves on its own
    }
  }
  return result;
}

module.exports = {
  downloadFhirPackage,
  downloadFhirPackages,
  resolvePackageDir,
  resolvePackageId,
  getFhirPackagesDir,
  packageHasSnapshots,
  resolvePackageDependencyDirs,
  compareVersions,
};
