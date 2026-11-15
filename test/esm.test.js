import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import inquirer from 'inquirer';

import { buildProgram, isEntryPoint } from '../bin/complies-with-eu.js';
import { isSupportedNodeVersion, MIN_NODE_VERSION } from '../src/commands/doctor.js';
import { getPackageInfo, loadToolsManifest, loadEuPackages } from '../src/lib/config.js';

const ROOT = path.join(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'complies-with-eu.js');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('package is ESM and requires Node >= 22.13', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, `>=${MIN_NODE_VERSION.replace(/\.0$/, '')}`);
});

test('importing the bin module does not run the CLI', () => {
  // Reaching this line means the import above did not parse the test runner's argv.
  assert.equal(typeof buildProgram, 'function');
  assert.equal(isEntryPoint(path.join(import.meta.dirname, 'esm.test.js')), false);
  assert.equal(isEntryPoint(undefined), false);
  assert.equal(isEntryPoint(path.join(ROOT, 'does-not-exist.js')), false);
  assert.equal(isEntryPoint(BIN), true);
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
  const res = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), pkg.version);
});

test('package data files are loaded from the install directory', () => {
  assert.equal(getPackageInfo().version, pkg.version);
  assert.ok(Object.keys(loadToolsManifest()).length > 0, 'tools.json');
  assert.ok(loadEuPackages().length > 0, 'eu-packages.json');
});

test('doctor: Node.js version check matches engines.node', () => {
  assert.equal(isSupportedNodeVersion('22.13.0'), true);
  assert.equal(isSupportedNodeVersion('22.19.0'), true);
  assert.equal(isSupportedNodeVersion('24.0.0'), true);
  assert.equal(isSupportedNodeVersion('v23.1.0'), true);
  assert.equal(isSupportedNodeVersion('22.12.0'), false);
  assert.equal(isSupportedNodeVersion('20.18.1'), false);
  assert.equal(isSupportedNodeVersion(process.versions.node), true, 'the test runner itself is supported');
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
