'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  findProfileByCanonical,
  findEuProfilesByType,
  findAllProfilesInPackage,
  addCompliesWithExtensions,
  canonicalToSlug,
  findExamplesInPackage,
  addMetaProfileClaims,
} = require('../src/lib/profileUtils');

const CWP = 'http://hl7.org/fhir/StructureDefinition/structuredefinition-compliesWithProfile';

function writeAll(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
}

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-pu-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('canonicalToSlug', () => {
  assert.equal(canonicalToSlug('http://example.org/fhir/StructureDefinition/MyProfile'), 'example_org_fhir_StructureDefinition_MyProfile');
  assert.equal(canonicalToSlug('https://a.b/c--d/e_f'), 'a_b_c--d_e_f');
  assert.equal(canonicalToSlug('urn:x:y|1.0'), 'urn_x_y_1_0');
});

test('addCompliesWithExtensions: does not mutate and replaces existing claims', () => {
  const profile = { resourceType: 'StructureDefinition', extension: [{ url: 'other', valueString: 'x' }, { url: CWP, valueCanonical: 'old' }] };
  const copy = addCompliesWithExtensions(profile, ['a', 'b']);
  assert.notEqual(copy, profile);
  assert.equal(profile.extension.length, 2, 'original untouched');
  assert.deepEqual(copy.extension, [
    { url: 'other', valueString: 'x' },
    { url: CWP, valueCanonical: 'a' },
    { url: CWP, valueCanonical: 'b' },
  ]);
  assert.deepEqual(addCompliesWithExtensions({}, ['z']).extension, [{ url: CWP, valueCanonical: 'z' }]);
});

test('addMetaProfileClaims: keeps existing, adds missing, no duplicates, no mutation', () => {
  const res = { resourceType: 'Patient', meta: { profile: ['a'] } };
  const out = addMetaProfileClaims(res, ['a', 'b']);
  assert.deepEqual(out.meta.profile, ['a', 'b']);
  assert.deepEqual(res.meta.profile, ['a']);
  assert.deepEqual(addMetaProfileClaims({ resourceType: 'Patient' }, ['x']).meta.profile, ['x']);
});

test('package scanning helpers', async (t) => {
  const root = tmp(t);
  const pkg = path.join(root, 'pkg#1.0.0');
  writeAll(path.join(pkg, 'package'), {
    'sd-patient.json': { resourceType: 'StructureDefinition', url: 'http://x/P', name: 'P', id: 'p', type: 'Patient', kind: 'resource', version: '1.0.0' },
    'sd-obs.json': { resourceType: 'StructureDefinition', url: 'http://x/O', name: 'O', id: 'o', type: 'Observation', kind: 'resource' },
    'vs.json': { resourceType: 'ValueSet', url: 'http://x/vs' },
    'Patient-ex1.json': { resourceType: 'Patient', id: 'ex1' },
    'broken.json': '{',
    'notes.txt': 'x',
  });

  const found = await findProfileByCanonical(pkg, 'http://x/P');
  assert.equal(found.profile.name, 'P');
  assert.equal(path.basename(found.filePath), 'sd-patient.json');
  await assert.rejects(findProfileByCanonical(pkg, 'http://x/none'), /No StructureDefinition with url 'http:\/\/x\/none'/);

  const all = await findAllProfilesInPackage(pkg);
  assert.deepEqual(all.map(p => p.url).sort(), ['http://x/O', 'http://x/P']);

  const eu = await findEuProfilesByType([pkg, path.join(root, 'missing')], 'Patient');
  assert.deepEqual(eu, [{ url: 'http://x/P', version: '1.0.0' }]);

  // Without example/ dir: scan package/ for instances of the type
  let examples = await findExamplesInPackage(pkg, 'Patient');
  assert.deepEqual(examples.map(e => e.fileName), ['Patient-ex1.json']);

  // With example/ dir: only that directory is scanned
  writeAll(path.join(pkg, 'package', 'example'), { 'Patient-ex2.json': { resourceType: 'Patient', id: 'ex2' } });
  examples = await findExamplesInPackage(pkg, 'Patient');
  assert.deepEqual(examples.map(e => e.fileName), ['Patient-ex2.json']);
  assert.deepEqual(await findExamplesInPackage(pkg, 'StructureDefinition'), []);
});
