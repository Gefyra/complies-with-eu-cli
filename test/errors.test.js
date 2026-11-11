'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { EXIT, CliError, setExitCode, outcomeExitCode } = require('../src/lib/errors');

test('outcomeExitCode: default is always 0 (backward compatible for CI consumers)', () => {
  assert.equal(outcomeExitCode({ failOnNoncompliant: false }), 0);
  assert.equal(outcomeExitCode({ failOnNoncompliant: false, nonCompliant: 5, errored: 3 }), 0);
  assert.equal(outcomeExitCode({ failOnNoncompliant: undefined, nonCompliant: 1 }), 0);
});

test('outcomeExitCode: with --fail-on-noncompliant errors win over non-compliance', () => {
  assert.equal(outcomeExitCode({ failOnNoncompliant: true }), EXIT.OK);
  assert.equal(outcomeExitCode({ failOnNoncompliant: true, nonCompliant: 0, errored: 0 }), 0);
  assert.equal(outcomeExitCode({ failOnNoncompliant: true, nonCompliant: 2 }), EXIT.NON_COMPLIANT);
  assert.equal(outcomeExitCode({ failOnNoncompliant: true, nonCompliant: 2, errored: 1 }), EXIT.ERROR);
  assert.equal(outcomeExitCode({ failOnNoncompliant: true, errored: 1 }), EXIT.ERROR);
});

test('EXIT codes are 0/1/2', () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, NON_COMPLIANT: 1, ERROR: 2 });
});

test('CliError: defaults to exit code 2 and keeps the cause', () => {
  const cause = new Error('root');
  const e = new CliError('boom', { cause });
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'CliError');
  assert.equal(e.exitCode, 2);
  assert.equal(e.cause, cause);
  assert.equal(new CliError('x', { exitCode: 1 }).exitCode, 1);
});

test('setExitCode never lowers an existing non-zero code', (t) => {
  const saved = process.exitCode;
  t.after(() => { process.exitCode = saved; });
  process.exitCode = undefined;
  setExitCode(0);
  assert.equal(process.exitCode, undefined);
  setExitCode(1);
  assert.equal(process.exitCode, 1);
  setExitCode(2);
  assert.equal(process.exitCode, 2);
  setExitCode(1);
  assert.equal(process.exitCode, 2);
  process.exitCode = saved;
});
