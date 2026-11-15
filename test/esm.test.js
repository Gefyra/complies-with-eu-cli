import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import inquirer from 'inquirer';

import { buildProgram, handleError, isEntryPoint } from '../bin/complies-with-eu.js';
import { isSupportedNodeVersion, satisfiesNodeRange, NODE_ENGINES, MIN_NODE_VERSION } from '../src/commands/doctor.js';
import { getPackageInfo, loadToolsManifest, loadEuPackages } from '../src/lib/config.js';
import { EXIT } from '../src/lib/errors.js';

const ROOT = path.join(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'complies-with-eu.js');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function runBin(args, nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, ...args], { encoding: 'utf8', timeout: 60_000 });
}

test('package is ESM and engines.node matches doctor', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, NODE_ENGINES);
  assert.equal(pkg.bin['complies-with-eu'], 'bin/complies-with-eu.js');
  assert.ok(isSupportedNodeVersion(MIN_NODE_VERSION), 'MIN_NODE_VERSION is supported');
});

test('engines.node is not wider than the engines of the direct dependencies', () => {
  // Every Node.js version the CLI accepts must also be accepted by each dependency.
  const probes = [];
  for (let major = 18; major <= 30; major++) {
    for (const minor of [0, 1, 12, 13, 14, 15, 16, 21, 22, 23, 99]) {
      for (const patch of [0, 1, 2, 3, 99]) probes.push(`${major}.${minor}.${patch}`);
    }
  }
  const accepted = probes.filter((v) => satisfiesNodeRange(v, pkg.engines.node));
  assert.ok(accepted.includes(MIN_NODE_VERSION));
  for (const dep of Object.keys(pkg.dependencies)) {
    const depPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', dep, 'package.json'), 'utf8'));
    const range = depPkg.engines && depPkg.engines.node;
    if (!range) continue;
    const rejected = accepted.filter((v) => !satisfiesNodeRange(v, range));
    assert.deepEqual(rejected, [], `${dep} (engines.node "${range}") does not support Node.js ${rejected.slice(0, 5).join(', ')}`);
  }
});

test('every module under src/ loads as ESM and commands export their run functions', async () => {
  // Commands are imported lazily by the bin, so a broken import would otherwise only
  // show up when a user runs that command.
  const expected = {
    'buildIndex.js': ['runBuildIndex'],
    'clean.js': ['runClean'],
    'doctor.js': ['runDoctor'],
    'init.js': ['runInit'],
    'search.js': ['runSearch'],
    'validate.js': ['runValidate', 'runValidateBatchFile', 'runValidatePackage'],
  };
  const commandsDir = path.join(ROOT, 'src', 'commands');
  const commandFiles = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));
  assert.deepEqual(commandFiles.sort(), Object.keys(expected).sort(), 'every command has expected exports listed');
  for (const file of commandFiles) {
    const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
    for (const name of expected[file]) assert.equal(typeof mod[name], 'function', `${file} exports ${name}`);
  }
  const libDir = path.join(ROOT, 'src', 'lib');
  for (const file of fs.readdirSync(libDir).filter((f) => f.endsWith('.js'))) {
    const mod = await import(pathToFileURL(path.join(libDir, file)).href);
    assert.ok(Object.keys(mod).length > 0, `${file} has exports`);
  }
});

test('Ctrl+C in a prompt prints "Cancelled." and exits 130', (t) => {
  const written = [];
  const origWrite = process.stderr.write;
  const origExitCode = process.exitCode;
  t.after(() => {
    process.stderr.write = origWrite;
    process.exitCode = origExitCode;
  });
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  // Same shape as inquirer's ExitPromptError (@inquirer/core).
  class ExitPromptError extends Error {
    name = 'ExitPromptError';
  }
  handleError(new ExitPromptError('User force closed the prompt with SIGINT'), ['node', 'bin']);
  const exitCode = process.exitCode;
  process.stderr.write = origWrite;
  process.exitCode = origExitCode;
  assert.equal(exitCode, EXIT.CANCELLED);
  assert.equal(EXIT.CANCELLED, 130);
  assert.equal(written.join(''), '\nCancelled.\n');
});

test('importing the bin module does not run the CLI', () => {
  // Reaching this line means the import above did not parse the test runner's argv.
  assert.equal(typeof buildProgram, 'function');
  assert.equal(isEntryPoint(path.join(import.meta.dirname, 'esm.test.js')), false);
  assert.equal(isEntryPoint(undefined), false);
  assert.equal(isEntryPoint(path.join(ROOT, 'does-not-exist.js')), false);
  assert.equal(isEntryPoint(BIN), true);
  assert.equal(isEntryPoint(BIN.replace(/\.js$/, '')), true, 'extensionless path, as Node resolves it');
  assert.equal(isEntryPoint(path.relative(process.cwd(), BIN)), true, 'relative path');
});

test('the CLI runs when started without the .js extension', () => {
  const res = runBin([BIN.replace(/\.js$/, ''), '--version']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), pkg.version);
});

test('the CLI runs with --preserve-symlinks-main through a linked directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-dirlink-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'pkg');
  try {
    fs.symlinkSync(ROOT, link, 'junction');
  } catch (err) {
    t.skip(`directory links not available (${err.code})`);
    return;
  }
  const res = runBin([path.join(link, 'bin', 'complies-with-eu.js'), '--version'], ['--preserve-symlinks-main']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), pkg.version);
});

test('the CLI runs through a symlink, as with the npm bin link', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'complies-with-eu');
  try {
    fs.symlinkSync(BIN, link, 'file');
  } catch (err) {
    t.skip(`symlinks not available (${err.code})`);
    return;
  }
  const res = runBin([link, '--version']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), pkg.version);
});

test('package data files are loaded from the install directory', () => {
  assert.equal(getPackageInfo().version, pkg.version);
  assert.ok(Object.keys(loadToolsManifest()).length > 0, 'tools.json');
  assert.ok(loadEuPackages().length > 0, 'eu-packages.json');
});

test('doctor: Node.js version check matches engines.node', () => {
  for (const v of ['22.22.2', 'v22.23.0', '24.15.0', '24.20.1', '26.0.0', '27.3.0']) {
    assert.equal(isSupportedNodeVersion(v), true, v);
  }
  for (const v of ['20.18.1', '22.13.0', '22.22.1', 'v23.1.0', '24.0.0', '24.14.9', '25.9.0']) {
    assert.equal(isSupportedNodeVersion(v), false, v);
  }
});

test('satisfiesNodeRange handles the engines.node forms used by the dependencies', () => {
  assert.equal(satisfiesNodeRange('22.0.0', '>=22'), true);
  assert.equal(satisfiesNodeRange('21.9.9', '>=22'), false);
  assert.equal(satisfiesNodeRange('22.12.0', '>=22.12.0'), true);
  assert.equal(satisfiesNodeRange('22.11.0', '>=22.12.0'), false);
  assert.equal(satisfiesNodeRange('18.0.0', '>=14.14'), true);
  assert.equal(satisfiesNodeRange('20.1.0', '>=18 <21'), true);
  assert.equal(satisfiesNodeRange('21.0.0', '>=18 <21'), false);
  assert.equal(satisfiesNodeRange('23.0.0', '^22.22.2 || ^24.15.0'), false);
});

test('every inquirer prompt type used in the commands is registered', () => {
  const registered = Object.keys(inquirer.prompt.prompts);
  const used = new Set();
  for (const file of ['search.js', 'validate.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'commands', file), 'utf8');
    for (const m of src.matchAll(/\(\[\s*\{\s*type: '(\w+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 0, 'found prompt definitions');
  for (const type of used) assert.ok(registered.includes(type), `prompt type '${type}' is not registered in inquirer`);
  assert.equal(typeof inquirer.createPromptModule, 'function');
  assert.equal(typeof inquirer.Separator, 'function');
});
