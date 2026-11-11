'use strict';

const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const {
  getPackageInfo,
  getHome,
  getHomeToolsDir,
  resolveToolsDir,
  getWorkdir,
  setWorkdir,
  getCacheFile,
  loadEuPackages,
  loadToolsManifest,
} = require('../lib/config');
const { detectJava, requiredJavaMajor } = require('../lib/javaCheck');
const { readInstalledVersionsSync, resolveToolSpec } = require('../lib/toolDownloader');
const { resolvePackageDir, resolvePackageId, getFhirPackagesDir } = require('../lib/fhirPkgTool');
const { EXIT, setExitCode } = require('../lib/errors');

const MIN_NODE_MAJOR = 18;

/**
 * Collects the environment diagnostics (no side effects besides running `java -version`).
 * @returns {Promise<object>}
 */
async function collectDiagnostics() {
  const manifest = loadToolsManifest();
  const pkg = getPackageInfo();
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
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
  if (nodeMajor < MIN_NODE_MAJOR) problems.push(`Node.js ${process.versions.node} is too old (need ${MIN_NODE_MAJOR}+, 20+ recommended)`);
  if (!java.found) problems.push(`Java not found (${java.error})`);
  else if (java.major !== null && java.major < minJava) problems.push(`Java ${java.major} is too old (need ${minJava}+)`);
  for (const t of tools) if (!t.present) problems.push(`${t.fileName} missing`);
  for (const p of euPackages) if (!p.present) problems.push(`EU package ${p.packageName}@${p.version} missing`);

  return {
    tool: pkg,
    node: { version: process.versions.node, ok: nodeMajor >= MIN_NODE_MAJOR },
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

module.exports = { runDoctor, collectDiagnostics };
