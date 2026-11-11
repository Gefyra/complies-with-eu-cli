'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkObligations, loadProfileByCanonical } = require('../src/lib/obligationCheck');

const OBL = 'http://hl7.org/fhir/StructureDefinition/obligation';
const INPUT = 'http://example.org/StructureDefinition/my-patient';
const EU = 'http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core';

const obligation = (code, actor = 'http://hl7.eu/fhir/base/ActorDefinition/creator') => ({
  url: OBL,
  extension: [{ url: 'code', valueCode: code }, { url: 'actor', valueCanonical: actor }],
});

function makePackage(root, name, resources, { withPackageSubdir = true } = {}) {
  const dir = path.join(root, name);
  const target = withPackageSubdir ? path.join(dir, 'package') : dir;
  fs.mkdirSync(target, { recursive: true });
  resources.forEach((r, i) => fs.writeFileSync(path.join(target, `r${i}.json`), JSON.stringify(r)));
  fs.writeFileSync(path.join(target, 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(target, 'readme.txt'), 'ignored');
  return dir;
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-obl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const inputSd = {
    resourceType: 'StructureDefinition',
    url: INPUT,
    snapshot: { element: [
      { id: 'Patient', path: 'Patient', min: 0, max: '*' },
      { id: 'Patient.identifier', path: 'Patient.identifier', min: 1, max: '*', mustSupport: true },
      { id: 'Patient.name', path: 'Patient.name', min: 0, max: '*' },
      { id: 'Patient.birthDate', path: 'Patient.birthDate', min: 0, max: '0', mustSupport: true },
      { id: 'Patient.gender', path: 'Patient.gender', min: 0, max: '1', mustSupport: true },
    ] },
  };
  const euSd = {
    resourceType: 'StructureDefinition',
    url: EU,
    differential: { element: [
      // Matches via path (EU uses the profile name in ids)
      { id: 'PatientEuCore.identifier', path: 'Patient.identifier', extension: [obligation('SHALL:able-to-populate')] },
      // Not mustSupport in input
      { id: 'Patient.name', path: 'Patient.name', extension: [obligation('SHALL:able-to-populate')] },
      // max 0 in input
      { id: 'Patient.birthDate', path: 'Patient.birthDate', extension: [obligation('SHOULD:able-to-populate')] },
      // Not found in input
      { id: 'Patient.address', path: 'Patient.address', extension: [obligation('SHALL:able-to-populate')] },
      // Irrelevant strength / code
      { id: 'Patient.telecom', path: 'Patient.telecom', extension: [obligation('MAY:able-to-populate')] },
      { id: 'Patient.contact', path: 'Patient.contact', extension: [obligation('SHALL:display')] },
      // Fine: mustSupport and max 1
      { id: 'Patient.gender', path: 'Patient.gender', extension: [obligation('SHALL:able-to-populate')] },
    ] },
  };
  const inputDir = makePackage(root, 'input#1.0.0', [inputSd, { resourceType: 'Patient', id: 'p1' }]);
  const euDirEmpty = makePackage(root, 'eu-other#1.0.0', []);
  const euDir = makePackage(root, 'eu#1.0.0', [euSd], { withPackageSubdir: false });
  return { inputDir, euDir, euDirEmpty };
}

test('loadProfileByCanonical: finds SD in package/ or root, skips broken files', async (t) => {
  const { inputDir, euDir } = setup(t);
  assert.equal((await loadProfileByCanonical(inputDir, INPUT)).url, INPUT);
  assert.equal((await loadProfileByCanonical(euDir, EU)).url, EU);
  assert.equal(await loadProfileByCanonical(inputDir, 'http://nope'), null);
});

test('checkObligations: reports missing mustSupport, max 0 and missing elements only', async (t) => {
  const { inputDir, euDir, euDirEmpty } = setup(t);
  const violations = await checkObligations(inputDir, INPUT, [euDirEmpty, euDir], EU);
  const byId = Object.fromEntries(violations.map(v => [v.euElementId, v]));

  assert.deepEqual(Object.keys(byId).sort(), ['Patient.address', 'Patient.birthDate', 'Patient.name']);

  assert.equal(byId['Patient.name'].missingMustSupport, true);
  assert.equal(byId['Patient.name'].maxIsZero, false);
  assert.equal(byId['Patient.name'].inputCardinality, '0..*');
  assert.equal(byId['Patient.name'].strength, 'SHALL');
  assert.equal(byId['Patient.name'].actor, 'http://hl7.eu/fhir/base/ActorDefinition/creator');

  assert.equal(byId['Patient.birthDate'].maxIsZero, true);
  assert.equal(byId['Patient.birthDate'].strength, 'SHOULD');
  assert.equal(byId['Patient.birthDate'].missingMustSupport, false);

  assert.equal(byId['Patient.address'].matchType, 'notFound');
  assert.equal(byId['Patient.address'].inputElementId, null);
  assert.equal(byId['Patient.address'].inputCardinality, null);
});

test('checkObligations: unknown profiles yield no violations', async (t) => {
  const { inputDir, euDir } = setup(t);
  assert.deepEqual(await checkObligations(inputDir, 'http://nope', [euDir], EU), []);
  assert.deepEqual(await checkObligations(inputDir, INPUT, euDir, 'http://nope'), []);
});
