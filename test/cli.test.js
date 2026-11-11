'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'complies-with-eu.js');
const pkg = require('../package.json');

// Isolated state dir: the smoke tests must never touch the real ~/.complies-with-eu.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-cli-'));
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
    env: {
      ...process.env,
      COMPLIES_WITH_EU_HOME: HOME,
      COMPLIES_WITH_EU_WORKDIR: path.join(HOME, 'workdir'),
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

test('--version prints the package.json version and exits 0', () => {
  const r = run(['--version']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), pkg.version);
});

test('--help lists every command and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0, r.stderr);
  for (const cmd of ['init', 'doctor', 'validate', 'validate-batch', 'search', 'build-index', 'clean']) {
    assert.match(r.stdout, new RegExp(`^\\s+${cmd}\\b`, 'm'), `command ${cmd} listed`);
  }
});

test('flags used by CI integrations stay available', () => {
  const validate = run(['validate', '--help']);
  assert.equal(validate.code, 0, validate.stderr);
  for (const flag of ['--eu-profiles', '--json', '--output', '--fail-on-noncompliant', '--all-counterparts', '--workdir', '--examples']) {
    assert.ok(validate.stdout.includes(flag), `validate ${flag}`);
  }
  const batch = run(['validate-batch', '--help']);
  assert.equal(batch.code, 0, batch.stderr);
  for (const flag of ['--json', '--output', '--fail-on-noncompliant']) {
    assert.ok(batch.stdout.includes(flag), `validate-batch ${flag}`);
  }
  const index = run(['build-index', '--help']);
  assert.equal(index.code, 0, index.stderr);
  assert.ok(index.stdout.includes('--output'));
  assert.equal(run(['init', '--help']).code, 0);
});

test('usage errors exit 2 with a message on stderr and nothing on stdout', () => {
  for (const args of [
    ['no-such-command'],
    ['validate'],
    ['validate', 'pkg@1.0.0', 'http://x/P', '--no-such-option'],
    ['validate', 'pkg@1.0.0', 'http://x/P', '--output', path.join(HOME, 'out.json')],
  ]) {
    const r = run(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '', args.join(' '));
    assert.ok(r.stderr.trim().length > 0, args.join(' '));
  }
});

test('search refuses to run without a terminal (exit 2)', () => {
  const r = run(['search', 'hl7.fhir.uv.ips@2.0.0']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs a terminal/);
});
