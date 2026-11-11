'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseValidatorOutput,
  parseValidatorOutputBatch,
  mapSettled,
} = require('../src/lib/javaValidator');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('parseValidatorOutput: summary (with ANSI codes), issues, ids and sub-details', () => {
  const { summary, issues } = parseValidatorOutput(fixture('validator-single.txt'));
  assert.deepEqual(summary, { result: 'FAILURE', text: '2 errors, 1 warnings, 1 notes' });
  assert.equal(issues.length, 4);

  const [cwp, tx, warn, info] = issues;
  assert.equal(cwp.severity, 'error');
  assert.equal(cwp.location, 'StructureDefinition');
  assert.equal(cwp.line, 1);
  assert.equal(cwp.col, 2);
  assert.equal(cwp.msgId, 'SD_EXTENSION_COMPLIES_WITH_ERROR');
  assert.match(cwp.message, /claimed profile 'http:\/\/hl7\.eu\/fhir\/base\/StructureDefinition\/patient-eu-core'$/);
  assert.equal(cwp.details.length, 2);
  assert.match(cwp.details[1], /^slice error: The constraint 'family\.exists\(\) or given\.exists\(\)'/);

  assert.equal(tx.msgId, 'Terminology_TX_Code_ValueSet');
  assert.equal(tx.location, 'StructureDefinition.differential.element[3]');
  assert.equal(tx.line, null);

  assert.equal(warn.severity, 'warning');
  assert.equal(warn.msgId, null);
  assert.equal(warn.message, 'Some warning without an id');

  assert.equal(info.severity, 'information');
  assert.equal(info.msgId, 'INFO_1');
});

test('parseValidatorOutput: empty or crashed output yields no summary (never a pass)', () => {
  for (const out of ['', '\n\n', fixture('validator-crash.txt')]) {
    const parsed = parseValidatorOutput(out);
    assert.equal(parsed.summary, null);
    assert.deepEqual(parsed.issues, []);
  }
});

test('parseValidatorOutput: compliesWithProfile failure without {MSG_ID} is recognised by its text', () => {
  const out = [
    '*FAILURE*: 1 errors, 0 warnings, 0 notes',
    "  Error @ StructureDefinition: The profile does not comply with claimed profile 'http://x/eu' because: slice error: The min value of '0' on the path Patient.name does not comply with the value '1' from the claimed profile and Mismatch in slicing at Patient.identifier: foo",
  ].join('\n');
  const { issues } = parseValidatorOutput(out);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].msgId, 'SD_EXTENSION_COMPLIES_WITH_ERROR');
  assert.equal(issues[0].message, "The profile does not comply with claimed profile 'http://x/eu'");
  assert.equal(issues[0].details.length, 2, 'inline "because:" details are split');
  assert.match(issues[0].details[1], /^Mismatch in slicing at Patient\.identifier/);
});

test('parseValidatorOutput: SUCCESS summary', () => {
  const { summary, issues } = parseValidatorOutput('*SUCCESS*: 0 errors, 0 warnings, 0 notes\r\n');
  assert.deepEqual(summary, { result: 'SUCCESS', text: '0 errors, 0 warnings, 0 notes' });
  assert.deepEqual(issues, []);
});

test('parseValidatorOutputBatch: validator 6.x/7.x result headers split issues per file', () => {
  const results = parseValidatorOutputBatch(fixture('validator-batch-v7.txt'));
  assert.deepEqual(results.map(r => r.fileName), ['Patient-a.json', 'Patient-b.json', 'Patient-c.json']);
  assert.equal(results[0].summary.result, 'SUCCESS');
  assert.equal(results[0].issues.length, 1);
  assert.equal(results[1].summary.result, 'FAILURE');
  assert.equal(results[1].issues.length, 1);
  assert.equal(results[1].issues[0].line, 5);
  assert.equal(results[2].summary.result, 'FAILURE');
  assert.deepEqual(results[2].issues.map(i => i.msgId), ['E1', 'E2']);
  // Every file has its own summary: none silently "passes" without a result
  assert.ok(results.every(r => r.summary));
});

test('parseValidatorOutputBatch: legacy "-- Validating <file> --" headers', () => {
  const results = parseValidatorOutputBatch(fixture('validator-batch-legacy.txt'));
  assert.deepEqual(results.map(r => r.fileName), ['Patient-a.json', 'Patient-b.json']);
  assert.equal(results[0].summary.result, 'SUCCESS');
  assert.equal(results[1].issues[0].msgId, 'LEGACY_ERR');
});

test('parseValidatorOutputBatch: no headers / crash output gives no results', () => {
  assert.deepEqual(parseValidatorOutputBatch(''), []);
  assert.deepEqual(parseValidatorOutputBatch(fixture('validator-crash.txt')), []);
});

test('mapSettled: keeps input order, isolates failures and respects the limit', async () => {
  let running = 0;
  let maxRunning = 0;
  const items = [1, 2, 3, 4, 5, 6, 7];
  const results = await mapSettled(items, 3, async (n) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise(r => setTimeout(r, (8 - n) * 2));
    running--;
    if (n === 4) throw new Error('four');
    return n * 10;
  });
  assert.ok(maxRunning <= 3);
  assert.equal(results.length, items.length);
  assert.deepEqual(results[0], { status: 'fulfilled', value: 10 });
  assert.equal(results[3].status, 'rejected');
  assert.equal(results[3].reason.message, 'four');
  assert.deepEqual(results[6], { status: 'fulfilled', value: 70 });
  assert.deepEqual(await mapSettled([], 4, async () => 1), []);
});
