'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs-extra');

/**
 * Package root (read-only assets: eu-packages.json, tools.json,
 * java-validator-parameter.md). Never write user state here: with a global or
 * npx install this directory is not writable and is replaced on every update.
 */
const ROOT = path.resolve(__dirname, '..', '..');

const VALIDATOR_JAR_NAME = 'validator_cli.jar';
const FHIR_PKG_TOOL_JAR_NAME = 'fhir-pkg-tool.jar';

// Legacy (1.1.x and earlier) locations inside the package root. They are still read when
// the new per-user locations do not exist yet, so existing checkouts keep working.
const LEGACY_TOOLS_DIR = path.join(ROOT, '.tools');
const LEGACY_CACHE_FILE = path.join(ROOT, '.complies-with-cache.json');

// Set by commands that accept --workdir.
let workdirOverride = null;

// ── Pure resolvers (exported for tests) ─────────────────────────────────────

/**
 * Resolves the per-user home directory of complies-with-eu.
 * $COMPLIES_WITH_EU_HOME wins, otherwise ~/.complies-with-eu.
 */
function resolveHome(env = process.env, homedir = os.homedir()) {
  const fromEnv = env.COMPLIES_WITH_EU_HOME && env.COMPLIES_WITH_EU_HOME.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(homedir, '.complies-with-eu');
}

/**
 * Resolves the working directory for reports and intermediate files.
 * Priority: explicit override (--workdir) > $COMPLIES_WITH_EU_WORKDIR > <home>/workdir.
 */
function resolveWorkdir({ override = null, env = process.env, home = resolveHome(env) } = {}) {
  if (override) return path.resolve(override);
  const fromEnv = env.COMPLIES_WITH_EU_WORKDIR && env.COMPLIES_WITH_EU_WORKDIR.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(home, 'workdir');
}

/**
 * Picks the tools directory to use at runtime.
 * The new per-user directory wins as soon as it contains both JARs. A legacy
 * in-repo .tools directory is used only when it is complete and the new one is not.
 *
 * @param {object}   p
 * @param {string}   p.homeToolsDir
 * @param {string}   p.legacyToolsDir
 * @param {Function} p.exists - (absPath) => boolean
 */
function pickToolsDir({ homeToolsDir, legacyToolsDir, exists }) {
  const complete = (dir) =>
    exists(path.join(dir, VALIDATOR_JAR_NAME)) && exists(path.join(dir, FHIR_PKG_TOOL_JAR_NAME));
  if (complete(homeToolsDir)) return { dir: homeToolsDir, legacy: false };
  if (legacyToolsDir && complete(legacyToolsDir)) return { dir: legacyToolsDir, legacy: true };
  return { dir: homeToolsDir, legacy: false };
}

/**
 * Parses the contents of java-validator-parameter.md into CLI args.
 *
 * - Lines starting with '#' are comments (this also covers Markdown headings).
 * - Lines not starting with '-' are ignored.
 * - "-flag" becomes ['-flag'].
 * - "-key value with spaces" becomes ['-key', 'value with spaces'] (split on the first whitespace only).
 * - -output and -html-output are dropped because the CLI parses console output itself.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseValidatorParams(raw) {
  const args = [];
  for (const rawLine of String(raw).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.startsWith('-')) continue;
    const m = line.match(/^(\S+)(?:\s+(.+))?$/);
    const key = m[1];
    const value = m[2] !== undefined ? m[2].trim() : undefined;
    if (key === '-output' || key === '-html-output') continue;
    args.push(key);
    if (value !== undefined && value !== '') args.push(value);
  }
  return args;
}

// ── Read-only package assets ────────────────────────────────────────────────

function loadEuPackages() {
  return fs.readJsonSync(path.join(ROOT, 'eu-packages.json'));
}

function loadValidatorParams() {
  const raw = fs.readFileSync(path.join(ROOT, 'java-validator-parameter.md'), 'utf8');
  return parseValidatorParams(raw);
}

/** Pinned external tool versions (tools.json). */
function loadToolsManifest() {
  return fs.readJsonSync(path.join(ROOT, 'tools.json'));
}

function getPackageInfo() {
  const pkg = fs.readJsonSync(path.join(ROOT, 'package.json'));
  return { name: pkg.name, version: pkg.version };
}

// ── User state locations ────────────────────────────────────────────────────

function getHome() {
  return resolveHome();
}

/** Where `init` installs tools: <home>/tools. */
function getHomeToolsDir() {
  return path.join(getHome(), 'tools');
}

function getLegacyToolsDir() {
  return LEGACY_TOOLS_DIR;
}

/** Tools directory used at runtime (new location, or a complete legacy one). */
function resolveToolsDir() {
  return pickToolsDir({
    homeToolsDir: getHomeToolsDir(),
    legacyToolsDir: LEGACY_TOOLS_DIR,
    exists: (p) => fs.pathExistsSync(p),
  });
}

function getToolsDir() {
  return resolveToolsDir().dir;
}

function getFhirPkgToolJar() {
  return path.join(getToolsDir(), FHIR_PKG_TOOL_JAR_NAME);
}

function getValidatorJar() {
  return path.join(getToolsDir(), VALIDATOR_JAR_NAME);
}

function setWorkdir(dir) {
  workdirOverride = dir ? path.resolve(dir) : null;
}

function getWorkdir() {
  return resolveWorkdir({ override: workdirOverride, home: getHome() });
}

function getCacheFile() {
  return path.join(getHome(), 'cache.json');
}

function readCacheObject() {
  const file = getCacheFile();
  if (fs.pathExistsSync(file)) return fs.readJsonSync(file, { throws: false }) ?? {};
  // Transparent fallback to the legacy in-repo cache file
  if (fs.pathExistsSync(LEGACY_CACHE_FILE)) return fs.readJsonSync(LEGACY_CACHE_FILE, { throws: false }) ?? {};
  return {};
}

/**
 * Returns the cached set of selected EU canonicals for a given profile canonical,
 * or null if no cache entry exists yet.
 *
 * @param {string} canonical - The profile canonical URL used as cache key
 * @returns {string[]|null}
 */
function loadSelectionCache(canonical) {
  return readCacheObject()[canonical] ?? null;
}

/**
 * Returns the full selection cache as a plain object { [canonical]: string[] },
 * or an empty object if no cache file exists yet.
 */
function loadAllSelectionCaches() {
  return readCacheObject();
}

/**
 * Persists the selected EU canonicals for a given profile canonical.
 * The first write migrates entries from the legacy cache file.
 *
 * @param {string}   canonical - The profile canonical URL used as cache key
 * @param {string[]} selected  - The selected EU canonical URLs
 */
function saveSelectionCache(canonical, selected) {
  const cache = readCacheObject();
  cache[canonical] = selected;
  fs.outputJsonSync(getCacheFile(), cache, { spaces: 2 });
}

module.exports = {
  ROOT,
  VALIDATOR_JAR_NAME,
  FHIR_PKG_TOOL_JAR_NAME,
  // pure helpers
  resolveHome,
  resolveWorkdir,
  pickToolsDir,
  parseValidatorParams,
  // assets
  loadEuPackages,
  loadValidatorParams,
  loadToolsManifest,
  getPackageInfo,
  // state
  getHome,
  getHomeToolsDir,
  getLegacyToolsDir,
  resolveToolsDir,
  getToolsDir,
  getFhirPkgToolJar,
  getValidatorJar,
  setWorkdir,
  getWorkdir,
  getCacheFile,
  loadSelectionCache,
  loadAllSelectionCaches,
  saveSelectionCache,
};
