'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseOperationOutcome } = require('../src/lib/javaValidatorServer');

const oo = require(path.join(__dirname, 'fixtures', 'operation-outcome.json'));

test('parseOperationOutcome: non-OperationOutcome input gives no summary', () => {
  assert.deepEqual(parseOperationOutcome(null), { summary: null, issues: [] });
  assert.deepEqual(parseOperationOutcome({ resourceType: 'Bundle' }), { summary: null, issues: [] });
});

test('parseOperationOutcome: message ids from coding, extension, suffix and compliesWith text fallback', () => {
  const { summary, issues } = parseOperationOutcome(oo);
  assert.deepEqual(summary, { result: 'FAILURE', text: '2 errors, 1 warnings, 1 notes' });
  assert.equal(issues.length, 4);

  // validator 7.x: no message id at all -> recognised by text (load-bearing: avoids a false pass)
  assert.equal(issues[0].msgId, 'SD_EXTENSION_COMPLIES_WITH_ERROR');
  assert.equal(issues[0].location, 'StructureDefinition');
  assert.equal(issues[0].message, "The profile does not comply with claimed profile 'http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core'");
  assert.equal(issues[0].details.length, 2);
  assert.match(issues[0].details[1], /^The constraint 'family\.exists\(\) or given\.exists\(\)'/);

  assert.equal(issues[1].msgId, 'Terminology_TX_Code_ValueSet');
  assert.equal(issues[1].message, 'Unknown code');
  assert.equal(issues[1].location, 'StructureDefinition.differential');

  assert.equal(issues[2].msgId, 'EXT_MSG_ID');
  assert.equal(issues[2].severity, 'warning');

  assert.equal(issues[3].msgId, 'SUFFIX_ID');
  assert.equal(issues[3].message, 'Note with suffix id');
});

test('parseOperationOutcome: empty issue list is a SUCCESS', () => {
  const { summary, issues } = parseOperationOutcome({ resourceType: 'OperationOutcome' });
  assert.equal(summary.result, 'SUCCESS');
  assert.deepEqual(issues, []);
});
