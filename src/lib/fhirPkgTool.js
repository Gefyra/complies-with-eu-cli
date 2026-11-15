import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { getFhirPkgToolJar, getHome } from './config.js';
import { getJavaCommand } from './javaCheck.js';
import { track } from './processRegistry.js';

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
 * @param {{ verbose?: boolean }} [options] - verbose streams the tool output
 * @returns {Promise<{ installed: string[], logFile: string|null }>}
 */
async function downloadFhirPackage(packageSpec, options = {}) {
  const jar = await requirePkgToolJar();
  return runJar(jar, ['-p', packageSpec], [packageSpec], options);
}

/**
 * Runs multiple packages at once.
 * @param {Array<{packageName: string, version: string}>} packages
 * @param {{ verbose?: boolean }} [options]
 * @returns {Promise<{ installed: string[], logFile: string|null }>}
 */
async function downloadFhirPackages(packages, options = {}) {
  const jar = await requirePkgToolJar();
  const args = [];
  const specs = [];
  for (const pkg of packages) {
    const spec = `${pkg.packageName}@${pkg.version}`;
    specs.push(spec);
    args.push('-p', spec);
  }
  return runJar(jar, args, specs, options);
}

/**
 * Error thrown when fhir-pkg-tool fails. `message` is a short, user-facing
 * explanation; `output` holds the full tool output and `logFile` its location.
 */
class FhirPkgToolError extends Error {
  constructor(message, { code = null, output = '', logFile = null, reason = null } = {}) {
    super(message);
    this.name = 'FhirPkgToolError';
    this.code = code;
    this.output = output;
    this.logFile = logFile;
    this.reason = reason;
  }
}

/**
 * Extracts the useful facts from fhir-pkg-tool output (pure, for tests):
 * installed packages, per-package failures and the first Java exception
 * message (stack frames are dropped).
 * @param {string} output
 * @returns {{ installed: string[], failures: Array<{spec: string, reason: string}>, exception: string|null, notFound: boolean, network: boolean }}
 */
function summarizeFhirPkgToolOutput(output) {
  // eslint-disable-next-line no-control-regex
  const lines = String(output).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').split(/\r\n|\r|\n/);
  const installed = [];
  const failures = [];
  let exception = null;
  for (const raw of lines) {
    const line = raw.trim();
    let m = line.match(/^Installed package (\S+)/);
    if (m) { installed.push(m[1]); continue; }
    m = line.match(/^Failed to install requested package (\S+) \((.*)\)\.?/);
    if (m) { failures.push({ spec: m[1], reason: m[2].trim() }); continue; }
    if (!exception && /^(Exception in thread|Caused by:|[\w.$]+(Exception|Error)\b:?)/.test(line) && !/^\s*at /.test(raw)) {
      exception = line.replace(/^Exception in thread "[^"]*"\s*/, '');
    }
  }
  const text = [...failures.map(f => f.reason), exception || ''].join(' ');
  return {
    installed,
    failures,
    exception,
    notFound: /unable to resolve package id|not found|404/i.test(text),
    network: /UnknownHost|ConnectException|SocketTimeout|timed out|No route to host|SSLHandshake|Connection refused/i.test(text),
  };
}

/**
 * Builds the short user-facing message for a failed fhir-pkg-tool run (pure, for tests).
 */
function describeFhirPkgToolFailure({ code, specs, summary, logFile }) {
  const what = specs.length === 1 ? `'${specs[0]}'` : specs.map(s => `'${s}'`).join(', ');
  const lines = [];
  if (summary.network) {
    lines.push(`Could not download ${what}: the FHIR package registry could not be reached.`);
    lines.push('Check your network connection or proxy settings (packages.fhir.org / Simplifier).');
  } else if (summary.notFound) {
    lines.push(`Package ${what} was not found in the FHIR package registry.`);
    lines.push('Check the package name and version on https://packages.fhir.org or https://simplifier.net/packages.');
  } else {
    lines.push(`Could not download ${what} (fhir-pkg-tool exit code ${code}).`);
  }
  const reasons = summary.failures.length
    ? summary.failures.map(f => `${f.spec}: ${f.reason}`)
    : (summary.exception ? [summary.exception] : []);
  for (const r of reasons.slice(0, 5)) lines.push(`  Reason: ${r.length > 300 ? `${r.slice(0, 300)}…` : r}`);
  if (logFile) lines.push(`Full fhir-pkg-tool output: ${logFile}`);
  return lines.join('\n');
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

/** Location of the log with the output of the last fhir-pkg-tool run. */
function getFhirPkgToolLogFile() {
  return path.join(getHome(), 'logs', 'fhir-pkg-tool.log');
}

/**
 * Runs fhir-pkg-tool with Java. By default the tool output is captured (not
 * shown) and written to ~/.complies-with-eu/logs/fhir-pkg-tool.log; with
 * `verbose` it is streamed to stderr as well (stdout stays clean for --json).
 * Rejects with a FhirPkgToolError carrying a short explanation.
 */
function runJar(jar, args, specs = [], { verbose = false } = {}) {
  return new Promise((resolve, reject) => {
    const userHome = os.homedir();
    const jvmArgs = [`-Duser.home=${userHome}`, '-jar', jar, ...args];
    if (verbose) process.stderr.write(chalk.gray(`  java -jar ${path.basename(jar)} ${args.join(' ')}\n`));
    const chunks = [];
    const onData = (data) => {
      chunks.push(data);
      if (verbose) process.stderr.write(chalk.gray(data.toString()));
    };
    const proc = track(spawn(getJavaCommand(), jvmArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('close', async (code) => {
      const output = Buffer.concat(chunks).toString('utf8');
      let logFile = getFhirPkgToolLogFile();
      try {
        await fs.outputFile(logFile, `$ java ${jvmArgs.join(' ')}\n\n${output}`, 'utf8');
      } catch {
        logFile = null;
      }
      const summary = summarizeFhirPkgToolOutput(output);
      if (code !== 0) {
        reject(new FhirPkgToolError(describeFhirPkgToolFailure({ code, specs, summary, logFile }), {
          code, output, logFile, reason: summary.network ? 'network' : (summary.notFound ? 'not-found' : 'failed'),
        }));
      } else {
        resolve({ installed: summary.installed, logFile });
      }
    });
    proc.on('error', (err) => reject(new FhirPkgToolError(`Could not start Java for fhir-pkg-tool: ${err.message}`)));
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

export {
  downloadFhirPackage,
  downloadFhirPackages,
  resolvePackageDir,
  resolvePackageId,
  getFhirPackagesDir,
  packageHasSnapshots,
  resolvePackageDependencyDirs,
  compareVersions,
  FhirPkgToolError,
  summarizeFhirPkgToolOutput,
  describeFhirPkgToolFailure,
  getFhirPkgToolLogFile,
};
