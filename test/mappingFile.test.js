'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadPackageMapping, savePackageMapping, loadExternalMapping } = require('../src/lib/mappingFile');

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-map-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('savePackageMapping / loadPackageMapping round trip', async (t) => {
  const root = tmp(t);
  const pkgWorkdir = path.join(root, 'nested', 'kbv-basis-1-8-0');
  assert.equal(await loadPackageMapping(pkgWorkdir), null);

  const mappings = { 'http://x/P': ['http://eu/a', 'http://eu/b'] };
  await savePackageMapping(pkgWorkdir, 'kbv.basis@1.8.0', mappings);
  assert.deepEqual(await loadPackageMapping(pkgWorkdir), { package: 'kbv.basis@1.8.0', mappings });
});

test('loadPackageMapping returns null for a corrupt file', async (t) => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, 'mapping.json'), '{ broken');
  assert.equal(await loadPackageMapping(root), null);
});

test('loadExternalMapping validates existence and shape', async (t) => {
  const root = tmp(t);
  const good = path.join(root, 'good.json');
  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(good, JSON.stringify({ package: 'p@1', mappings: {} }));
  fs.writeFileSync(bad, JSON.stringify({ mappings: {} }));

  assert.deepEqual(await loadExternalMapping(good), { package: 'p@1', mappings: {} });
  await assert.rejects(loadExternalMapping(bad), /Invalid mapping file format/);
  await assert.rejects(loadExternalMapping(path.join(root, 'missing.json')), /Mapping file not found/);
});
