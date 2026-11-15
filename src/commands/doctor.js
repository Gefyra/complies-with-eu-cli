import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import {
  getPackageInfo,
  getHome,
  getHomeToolsDir,
  resolveToolsDir,
  getWorkdir,
  setWorkdir,
  getCacheFile,
  loadEuPackages,
  loadToolsManifest,
} from '../lib/config.js';
import { detectJava, requiredJavaMajor } from '../lib/javaCheck.js';
import { readInstalledVersionsSync, resolveToolSpec } from '../lib/toolDownloader.js';
import { resolvePackageDir, resolvePackageId, getFhirPackagesDir } from '../lib/fhirPkgTool.js';
import { EXIT, setExitCode } from '../lib/errors.js';

/**
 * Supported Node.js versions, identical to "engines.node" in package.json.
 * It follows the engines range of inquirer 14 and the @inquirer/* packages.
 */
const NODE_ENGINES = '^22.22.2 || ^24.15.0 || >=26.0.0';

/** Lowest supported Node.js version. */
const MIN_NODE_VERSION = '22.22.2';

/** Compares dotted numeric versions ("22.13.0"); returns <0, 0 or >0. */
function compareNodeVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * True when `version` satisfies `range`. Supports the subset of semver ranges
 * used by engines.node fields: "||" alternatives of space-separated
 * comparators (^x.y.z, >=, >, <=, <, = or a bare version), including partial
 * versions such as ">=22".
 */
function satisfiesNodeRange(version, range) {
  const ver = String(version).replace(/^v/, '');
  return String(range).split('||').some((alt) => {
    const comparators = alt.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return true;
    return comparators.every((comp) => {
      const m = /^(\^|>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2})$/.exec(comp);
      if (!m) return false;
      const [, op = '=', base] = m;
      const cmp = compareNodeVersions(ver, base);
      switch (op) {
        case '^': return cmp >= 0 && parseInt(ver, 10) === parseInt(base, 10);
        case '>=': return cmp >= 0;
        case '>': return cmp > 0;
        case '<=': return cmp <= 0;
        case '<': return cmp < 0;
        default: return cmp === 0;
      }
    });
  });
}

/** True when the given Node.js version satisfies NODE_ENGINES. */
function isSupportedNodeVersion(version = process.versions.node) {
  return satisfiesNodeRange(version, NODE_ENGINES);
}

/**
 * Collects the environment diagnostics (no side effects besides running `java -version`).
 * @returns {Promise<object>}
 */
async function collectDiagnostics() {
  const manifest = loadToolsManifest();
  const pkg = getPackageInfo();
  const nodeOk = isSupportedNodeVersion(process.versions.node);
  const minJava = requiredJavaMajor(manifest);
  const java = detectJava();
  const { dir: toolsDir, legacy } = resolveToolsDir();
  const installed = readInstalledVersionsSync(toolsDir);

  const tools = Object.values(manifest).map((tool) => {
    const jar = path.join(toolsDir, tool.fileName);
    const present = fs.pathExistsSync(jar);
    const spec = resolveToolSpec(tool);
    const installedVersion = installed[tool.fileName]?.version ?? null;
    const expected = spec.latest ? 'latest' : spec.version;
    return {
      name: tool.name,
      fileName: tool.fileName,
      path: jar,
      present,
      installedVersion,
      expectedVersion: expected,
      upToDate: present && (spec.latest || installedVersion === spec.version),
    };
  });

  const euPackages = [];
  for (const p of loadEuPackages()) {
    let dir = null;
    let resolvedVersion = null;
    try {
      dir = await resolvePackageDir(p.packageName, p.version);
      const id = await resolvePackageId(dir);
      resolvedVersion = id.includes('#') ? id.split('#')[1] : null;
    } catch {
      // missing
    }
    euPackages.push({ packageName: p.packageName, version: p.version, present: !!dir, resolvedVersion, dir });
  }

  const problems = [];
  if (!nodeOk) problems.push(`Node.js ${process.versions.node} is not supported (need ${NODE_ENGINES})`);
  if (!java.found) problems.push(`Java not found (${java.error})`);
  else if (java.major !== null && java.major < minJava) problems.push(`Java ${java.major} is too old (need ${minJava}+)`);
  for (const t of tools) if (!t.present) problems.push(`${t.fileName} missing`);
  for (const p of euPackages) if (!p.present) problems.push(`EU package ${p.packageName}@${p.version} missing`);

  return {
    tool: pkg,
    node: { version: process.versions.node, ok: nodeOk },
    java: { ...java, required: minJava, ok: java.found && (java.major === null || java.major >= minJava) },
    paths: {
      home: getHome(),
      toolsDir,
      toolsDirIsLegacy: legacy,
      homeToolsDir: getHomeToolsDir(),
      workdir: getWorkdir(),
      selectionCache: getCacheFile(),
      fhirPackages: getFhirPackagesDir(),
    },
    tools,
    euPackages,
    problems,
    ok: problems.length === 0,
  };
}

async function runDoctor(options = {}) {
  if (options.workdir) setWorkdir(options.workdir);
  const d = await collectDiagnostics();

  if (options.json) {
    process.stdout.write(JSON.stringify(d, null, 2) + '\n');
  } else {
    const ok = (b) => (b ? chalk.green('ok  ') : chalk.red('FAIL'));
    console.log(chalk.bold(`\n${d.tool.name} ${d.tool.version} doctor\n`));
    console.log(`  ${ok(d.node.ok)} Node.js ${d.node.version}`);
    console.log(`  ${ok(d.java.ok)} Java ${d.java.found ? `${d.java.major ?? '?'} (${d.java.command}, via ${d.java.source})` : 'not found'}, required: ${d.java.required}+`);
    console.log(chalk.bold('\n  Tools'));
    for (const t of d.tools) {
      const state = t.present
        ? `${t.installedVersion ?? 'unknown version'}${t.upToDate ? '' : chalk.yellow(` (expected ${t.expectedVersion}, run: complies-with-eu init)`)}`
        : 'missing';
      console.log(`  ${ok(t.present)} ${t.fileName}: ${state}`);
    }
    console.log(chalk.bold('\n  EU packages'));
    for (const p of d.euPackages) {
      console.log(`  ${ok(p.present)} ${p.packageName}@${p.version}${p.present && p.resolvedVersion && p.resolvedVersion !== p.version ? ` (→ ${p.resolvedVersion})` : ''}`);
    }
    console.log(chalk.bold('\n  Paths'));
    console.log(`       Home:            ${d.paths.home}`);
    console.log(`       Tools:           ${d.paths.toolsDir}${d.paths.toolsDirIsLegacy ? chalk.yellow(' (legacy location, run init to migrate)') : ''}`);
    console.log(`       Workdir/reports: ${d.paths.workdir}`);
    console.log(`       Selection cache: ${d.paths.selectionCache}`);
    console.log(`       FHIR packages:   ${d.paths.fhirPackages}`);
    console.log('');
    if (d.ok) {
      console.log(chalk.green('  Everything looks good.\n'));
    } else {
      console.log(chalk.red('  Problems:'));
      for (const p of d.problems) console.log(chalk.red(`   - ${p}`));
      console.log(chalk.gray('\n  Most problems are fixed by: complies-with-eu init (Java: https://adoptium.net)\n'));
    }
  }

  if (!d.ok) setExitCode(EXIT.ERROR);
}

export { runDoctor, collectDiagnostics, isSupportedNodeVersion, satisfiesNodeRange, NODE_ENGINES, MIN_NODE_VERSION };
