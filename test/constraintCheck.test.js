import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseExistsOrExpression,
  findConstraintBasePath,
  findConstraintPaths,
  isSatisfiedInInputSnapshot,
  isIgnoredSlicingDetail,
  evaluateExistsOrConstraints,
  resolveTypeSliceDetail,
} from '../src/lib/constraintCheck.js';

const EXT_URL = 'http://hl7.eu/fhir/base/StructureDefinition/patient-birthPlace';

const sd = (elements, { differentialOnly = false } = {}) => (differentialOnly
  ? { resourceType: 'StructureDefinition', differential: { element: elements } }
  : { resourceType: 'StructureDefinition', snapshot: { element: elements } });

test('parseExistsOrExpression: accepts pure exists()-or chains', () => {
  assert.deepEqual(parseExistsOrExpression('family.exists() or given.exists()'), { paths: ['family', 'given'], extensionUrls: [] });
  assert.deepEqual(
    parseExistsOrExpression(`name.family.exists()  or\n extension('${EXT_URL}').exists()`),
    { paths: ['name.family'], extensionUrls: [EXT_URL] },
  );
  assert.deepEqual(parseExistsOrExpression('text.exists()'), { paths: ['text'], extensionUrls: [] });
});

test('parseExistsOrExpression: rejects anything else', () => {
  for (const expr of [
    'family.exists() and given.exists()',
    'family.exists() or given.empty()',
    'name.where(use=\'official\').exists()',
    'family.exists() or',
    '',
    'family.count() > 0',
  ]) {
    assert.equal(parseExistsOrExpression(expr), null, expr);
  }
});

test('findConstraintBasePath: snapshot first, then differential', () => {
  const euSd = {
    snapshot: { element: [{ path: 'Patient' }, { path: 'Patient.name', constraint: [{ key: 'eu-1', expression: 'family.exists() or given.exists()' }] }] },
    differential: { element: [{ path: 'Patient.address', constraint: [{ expression: 'line.exists()' }] }] },
  };
  assert.equal(findConstraintBasePath(euSd, 'family.exists() or given.exists()'), 'Patient.name');
  assert.equal(findConstraintBasePath(euSd, 'line.exists()'), 'Patient.address');
  assert.equal(findConstraintBasePath(euSd, 'nope.exists()'), null);
  assert.equal(findConstraintBasePath({}, 'x.exists()'), null);
});

test('isSatisfiedInInputSnapshot: positive cases', () => {
  // Direct unsliced child with min >= 1
  let r = isSatisfiedInInputSnapshot(
    sd([{ id: 'Patient.name', path: 'Patient.name', min: 1 }, { id: 'Patient.name.family', path: 'Patient.name.family', min: 1 }]),
    'Patient.name', { paths: ['family', 'given'] },
  );
  assert.equal(r.satisfied, true);
  assert.equal(r.matchedChild, 'Patient.name.family (min: 1)');

  // Dotted term: every segment required
  r = isSatisfiedInInputSnapshot(
    sd([{ id: 'Patient.contact.name', path: 'Patient.contact.name', min: 1 }, { id: 'Patient.contact.name.family', path: 'Patient.contact.name.family', min: 1 }]),
    'Patient.contact', { paths: ['name.family'] },
  );
  assert.equal(r.satisfied, true);

  // Differential fallback when no snapshot is shipped
  r = isSatisfiedInInputSnapshot(
    sd([{ id: 'Patient.name.given', path: 'Patient.name.given', min: 2 }], { differentialOnly: true }),
    'Patient.name', { paths: ['family', 'given'] },
  );
  assert.equal(r.satisfied, true);

  // Extension slice directly on <base>.extension with min >= 1 and matching type profile
  r = isSatisfiedInInputSnapshot(
    sd([{ id: 'Patient.extension:birthPlace', path: 'Patient.extension', sliceName: 'birthPlace', min: 1, type: [{ code: 'Extension', profile: [EXT_URL] }] }]),
    'Patient', { paths: [], extensionUrls: [EXT_URL] },
  );
  assert.equal(r.satisfied, true);
  assert.equal(r.matchedChild, 'Patient.extension:birthPlace (min: 1)');
});

test('isSatisfiedInInputSnapshot: CQ-12 false-positive negatives', () => {
  const cases = [
    {
      name: 'child required only inside an optional slice',
      els: [{ id: 'Patient.name:official.family', path: 'Patient.name.family', min: 1 }],
      base: 'Patient.name', parsed: { paths: ['family'] },
    },
    {
      name: 'child has a sliceName',
      els: [{ id: 'Patient.name.family:x', path: 'Patient.name.family', sliceName: 'x', min: 1 }],
      base: 'Patient.name', parsed: { paths: ['family'] },
    },
    {
      name: 'child is optional (min 0)',
      els: [{ id: 'Patient.name.family', path: 'Patient.name.family', min: 0 }],
      base: 'Patient.name', parsed: { paths: ['family'] },
    },
    {
      name: 'child without min',
      els: [{ id: 'Patient.name.family', path: 'Patient.name.family' }],
      base: 'Patient.name', parsed: { paths: ['family'] },
    },
    {
      name: 'deeper descendant with the same last segment does not satisfy a direct-child term',
      els: [{ id: 'Patient.name.period.start', path: 'Patient.name.period.start', min: 1 }],
      base: 'Patient.name', parsed: { paths: ['start'] },
    },
    {
      name: 'dotted term with an optional intermediate segment',
      els: [
        { id: 'Patient.contact.name', path: 'Patient.contact.name', min: 0 },
        { id: 'Patient.contact.name.family', path: 'Patient.contact.name.family', min: 1 },
      ],
      base: 'Patient.contact', parsed: { paths: ['name.family'] },
    },
    {
      name: 'dotted term matched only by suffix (not full path)',
      els: [{ id: 'Patient.contact.name.family', path: 'Patient.contact.name.family', min: 1 }],
      base: 'Patient.contact', parsed: { paths: ['family'] },
    },
    {
      name: 'required element under a different base path',
      els: [{ id: 'Patient.contact.name.family', path: 'Patient.contact.name.family', min: 1 }],
      base: 'Patient.name', parsed: { paths: ['family'] },
    },
    {
      name: 'extension slice with min 0',
      els: [{ id: 'Patient.extension:bp', path: 'Patient.extension', sliceName: 'bp', min: 0, type: [{ code: 'Extension', profile: [EXT_URL] }] }],
      base: 'Patient', parsed: { paths: [], extensionUrls: [EXT_URL] },
    },
    {
      name: 'extension slice on a nested element, not directly on <base>.extension',
      els: [{ id: 'Patient.address.extension:bp', path: 'Patient.address.extension', sliceName: 'bp', min: 1, type: [{ code: 'Extension', profile: [EXT_URL] }] }],
      base: 'Patient', parsed: { paths: [], extensionUrls: [EXT_URL] },
    },
    {
      name: 'extension slice inside an ancestor slice',
      els: [{ id: 'Patient.name:official.extension:bp', path: 'Patient.name.extension', sliceName: 'bp', min: 1, type: [{ code: 'Extension', profile: [EXT_URL] }] }],
      base: 'Patient.name', parsed: { paths: [], extensionUrls: [EXT_URL] },
    },
    {
      name: 'fixedUri on .extension.url does not count',
      els: [
        { id: 'Patient.extension:bp', path: 'Patient.extension', sliceName: 'bp', min: 0 },
        { id: 'Patient.extension:bp.url', path: 'Patient.extension.url', min: 1, fixedUri: EXT_URL },
      ],
      base: 'Patient', parsed: { paths: [], extensionUrls: [EXT_URL] },
    },
    {
      name: 'required extension slice with a different profile',
      els: [{ id: 'Patient.extension:other', path: 'Patient.extension', sliceName: 'other', min: 1, type: [{ code: 'Extension', profile: ['http://other/ext'] }] }],
      base: 'Patient', parsed: { paths: [], extensionUrls: [EXT_URL] },
    },
    {
      name: 'empty SD',
      els: [],
      base: 'Patient', parsed: { paths: ['name'], extensionUrls: [EXT_URL] },
    },
  ];
  for (const c of cases) {
    const r = isSatisfiedInInputSnapshot(sd(c.els), c.base, c.parsed);
    assert.deepEqual(r, { satisfied: false, matchedChild: null }, c.name);
  }
});

test('isIgnoredSlicingDetail: only "no slicing" mismatches on extension paths are ignored', () => {
  assert.equal(isIgnoredSlicingDetail('slice error: Mismatch in slicing at Condition.extension: no slicing found'), true);
  assert.equal(isIgnoredSlicingDetail('Mismatch in slicing at Condition.extension:assertedDate: x'), true);
  assert.equal(isIgnoredSlicingDetail('Mismatch in slicing at extension: x'), true);
  assert.equal(isIgnoredSlicingDetail('slice error: Mismatch in slicing at Patient.identifier: no slicing found'), false);
  assert.equal(isIgnoredSlicingDetail("slice error: The min value of '0' on the path Patient.extension does not comply"), false);
  assert.equal(isIgnoredSlicingDetail('Mismatch in slicing at Patient.extensionFoo: x'), false);
});

test('evaluateExistsOrConstraints: resolves satisfied constraints, keeps the rest', () => {
  const expr = 'family.exists() or given.exists()';
  const unresolvable = 'text.exists()';
  const euCanonical = 'http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core';
  const euSd = { snapshot: { element: [
    { path: 'Patient.name', constraint: [{ expression: expr }] },
    { path: 'Patient', constraint: [{ expression: unresolvable }] },
  ] } };
  const inputSd = sd([{ id: 'Patient.name.family', path: 'Patient.name.family', min: 1 }]);

  const minDetail = "slice error: The min value of '0' on the path Patient.name does not comply with the value '1' from the claimed profile";
  const nonCompliantMap = new Map([
    [`${euCanonical}|0.1.0`, [
      `slice error: The constraint '${expr}' is defined in the claimed profile, but missing`,
      `slice error: The constraint '${unresolvable}' is defined in the claimed profile, but missing`,
      'slice error: Mismatch in slicing at Patient.extension: no slicing',
      minDetail,
    ]],
    ['http://unknown/eu', [`The constraint '${expr}' is defined in the claimed profile, but missing`]],
    ['http://only-ignored/eu', ['Mismatch in slicing at Patient.extension: x']],
  ]);
  const euSdByCanonical = new Map([[euCanonical, euSd]]);

  const { filteredMap, satisfied, unresolved } = evaluateExistsOrConstraints({ inputSd, euSdByCanonical, nonCompliantMap });
  assert.deepEqual(satisfied, [{
    euCanonical: `${euCanonical}|0.1.0`, expression: expr, basePath: 'Patient.name', matchedChild: 'Patient.name.family (min: 1)',
  }]);
  assert.deepEqual(filteredMap.get(`${euCanonical}|0.1.0`), [
    `slice error: The constraint '${unresolvable}' is defined in the claimed profile, but missing`,
    minDetail,
  ]);
  // Unknown EU SD: constraint is kept (conservative)
  assert.equal(filteredMap.get('http://unknown/eu').length, 1);
  // Only ignored details: profile counts as compliant
  assert.equal(filteredMap.has('http://only-ignored/eu'), false);
  // Kept exists()-or constraints record why they were not resolved
  assert.deepEqual(unresolved, [
    { euCanonical: `${euCanonical}|0.1.0`, expression: unresolvable, reason: 'unsatisfied' },
    { euCanonical: 'http://unknown/eu', expression: expr, reason: 'noEuSd' },
  ]);
});

test('evaluateExistsOrConstraints: reports unsatisfied and unlocatable exists()-or constraints', () => {
  const expr = 'family.exists() or given.exists()';
  const elsewhere = 'telecom.exists() or address.exists()';
  const euCanonical = 'http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core';
  const euSd = { snapshot: { element: [{ path: 'Patient.name', constraint: [{ expression: expr }] }] } };
  const inputSd = sd([{ id: 'Patient.name.family', path: 'Patient.name.family', min: 0 }]);
  const missing = e => `slice error: The constraint '${e}' is defined in the claimed profile, but missing`;
  const nonCompliantMap = new Map([[euCanonical, [missing(expr), missing(elsewhere), missing('value.empty() or code.empty()')]]]);

  const { filteredMap, satisfied, unresolved } = evaluateExistsOrConstraints({
    inputSd, euSdByCanonical: new Map([[euCanonical, euSd]]), nonCompliantMap,
  });
  assert.deepEqual(satisfied, []);
  assert.equal(filteredMap.get(euCanonical).length, 3);
  assert.deepEqual(unresolved, [
    { euCanonical, expression: expr, reason: 'unsatisfied' },
    { euCanonical, expression: elsewhere, reason: 'noBasePath' },
  ]);
});

test('findConstraintPaths: distinct element paths declaring an expression', () => {
  const sd = {
    snapshot: {
      element: [
        { path: 'Patient.name', constraint: [{ expression: 'x' }] },
        { path: 'Patient.name', id: 'Patient.name:official', constraint: [{ expression: 'x' }] },
        { path: 'Patient.contact.name', constraint: [{ expression: 'x' }, { expression: 'y' }] },
      ],
    },
    differential: { element: [{ path: 'Patient.other', constraint: [{ expression: 'z' }] }] },
  };
  assert.deepEqual(findConstraintPaths(sd, 'x'), ['Patient.name', 'Patient.contact.name']);
  assert.deepEqual(findConstraintPaths(sd, 'y'), ['Patient.contact.name']);
  // snapshot present: the differential is not consulted
  assert.deepEqual(findConstraintPaths(sd, 'z'), []);
  assert.deepEqual(findConstraintPaths({ differential: sd.differential }, 'z'), ['Patient.other']);
  assert.deepEqual(findConstraintPaths(null, 'x'), []);
});

// ── Type slices (verified against HL7 FHIR Validator 7.0.5) ──────────────────
const EU_CANON = 'http://hl7.eu/fhir/laboratory/StructureDefinition/Observation-resultslab-eu-lab|2.1.0';
const euObs = (sliceMin = 0) => sd([
  { id: 'Observation.value[x]', path: 'Observation.value[x]', min: 0, max: '1', type: ['Quantity', 'string', 'boolean'].map(code => ({ code })) },
  { id: 'Observation.value[x]:valueQuantity', path: 'Observation.value[x]', sliceName: 'valueQuantity', min: 0, max: '1' },
  { id: 'Observation.value[x]:valueBoolean', path: 'Observation.value[x]', sliceName: 'valueBoolean', min: sliceMin, max: '1' },
]);
const derivedObs = (types = ['Quantity', 'string'], max = '1') => sd([
  { id: 'Observation.value[x]', path: 'Observation.value[x]', min: 0, max, type: types.map(code => ({ code })) },
]);
const TYPE_DETAIL = 'slice error: Mismatch in slicing at Observation.value[x]:valueBoolean: no slice found for the discriminator type:$this with the values boolean';

test('resolveTypeSliceDetail: optional EU type slice whose type the profile does not allow is resolved', () => {
  const r = resolveTypeSliceDetail(TYPE_DETAIL, { inputSd: derivedObs(), euSd: euObs(), euCanonical: EU_CANON });
  assert.equal(r.kind, 'type-slice');
  assert.equal(r.basePath, 'Observation.value[x]:valueBoolean');
  assert.equal(r.type, 'boolean');
  assert.match(r.matchedChild, /not allowed here \(allowed: Quantity, string\)/);
});

test('resolveTypeSliceDetail: stays a finding when the EU slice is required, the type is allowed, the element is looser or the snapshot failed', () => {
  assert.equal(resolveTypeSliceDetail(TYPE_DETAIL, { inputSd: derivedObs(), euSd: euObs(1), euCanonical: EU_CANON }), null, 'required slice');
  assert.equal(resolveTypeSliceDetail(TYPE_DETAIL, { inputSd: derivedObs(['Quantity', 'boolean']), euSd: euObs(), euCanonical: EU_CANON }), null, 'type allowed');
  assert.equal(resolveTypeSliceDetail(TYPE_DETAIL, { inputSd: derivedObs(['Quantity'], '*'), euSd: euObs(), euCanonical: EU_CANON }), null, 'looser max');
  assert.equal(resolveTypeSliceDetail(TYPE_DETAIL, { inputSd: derivedObs(), euSd: euObs(), euCanonical: EU_CANON, snapshotOk: false }), null, 'snapshot error');
  assert.equal(resolveTypeSliceDetail(TYPE_DETAIL, { inputSd: derivedObs(), euSd: null, euCanonical: EU_CANON }), null, 'EU SD not loaded');
  const urlDetail = 'slice error: Mismatch in slicing at Observation.statusReason.extension:foo: no slice found for the discriminator value:url with the values http://x';
  assert.equal(resolveTypeSliceDetail(urlDetail, { inputSd: derivedObs(), euSd: euObs(), euCanonical: EU_CANON }), null, 'other discriminator');
});

test('evaluateExistsOrConstraints: profile passes when only optional type slices remain', () => {
  const nonCompliantMap = new Map([[EU_CANON, [TYPE_DETAIL]]]);
  const euSdByCanonical = new Map([[EU_CANON.split('|')[0], euObs()]]);
  const { filteredMap, satisfied } = evaluateExistsOrConstraints({ inputSd: derivedObs(), euSdByCanonical, nonCompliantMap });
  assert.equal(filteredMap.size, 0);
  assert.equal(satisfied.length, 1);
  assert.equal(satisfied[0].kind, 'type-slice');

  const failed = evaluateExistsOrConstraints({ inputSd: derivedObs(), euSdByCanonical, nonCompliantMap, snapshotOk: false });
  assert.equal(failed.filteredMap.size, 1, 'kept when the snapshot could not be generated');
});
