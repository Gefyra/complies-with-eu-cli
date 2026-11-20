import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import fs from 'fs-extra';

import { installLocalPackage, readTarEntries, safeEntryPath, readPackageIdentity } from '../src/lib/localPackage.js';

/** Builds one ustar entry (header + padded data). */
function tarEntry(name, content, { type = '0', prefix = '' } = {}) {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function tarball(entries) {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

const PACKAGE_JSON = JSON.stringify({ name: 'my.local.test', version: '0.1.0-dev', dependencies: { 'hl7.fhir.r4.core': '4.0.1' } });
const PROFILE = JSON.stringify({ resourceType: 'StructureDefinition', id: 'my-patient', url: 'http://example.org/StructureDefinition/my-patient' });

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwe-test-'));
  t.after(() => fs.remove(dir));
  return dir;
}

test('readTarEntries: regular files, directories, prefix, GNU long names and pax paths', () => {
  const longName = `package/${'x'.repeat(120)}.json`;
  const paxPath = 'package/pax-named.json';
  const paxRecord = `${String(` path=${paxPath}\n`.length + 2).padStart(2, '0')} path=${paxPath}\n`;
  const entries = readTarEntries(tarball([
    tarEntry('package/', '', { type: '5' }),
    tarEntry('package/package.json', PACKAGE_JSON),
    tarEntry('a.json', '{}', { prefix: 'package/sub' }),
    tarEntry('././@LongLink', `${longName}\0`, { type: 'L' }),
    tarEntry('package/truncated', '{"long":true}'),
    tarEntry('PaxHeader/x', paxRecord, { type: 'x' }),
    tarEntry('package/short', '{"pax":true}'),
  ]));
  assert.deepEqual(entries.map(e => e.name), ['package/package.json', 'package/sub/a.json', longName, paxPath]);
  assert.equal(entries[0].data.toString('utf8'), PACKAGE_JSON);
  assert.equal(entries[2].data.toString('utf8'), '{"long":true}');
  assert.throws(() => readTarEntries(tarEntry('package/a.json', 'a'.repeat(300)).subarray(0, 600)), /truncated/);
});

test('safeEntryPath: rejects paths that leave the target directory', () => {
  assert.equal(safeEntryPath('package/a.json'), 'package/a.json');
  assert.equal(safeEntryPath('./package//a.json'), 'package/a.json');
  for (const bad of ['../a.json', 'package/../../a.json', '/etc/passwd', 'C:\\Windows\\a.json', 'package\\..\\..\\a.json', '']) {
    assert.equal(safeEntryPath(bad), null, bad);
  }
});

test('readPackageIdentity: needs a usable name and version', () => {
  assert.deepEqual(readPackageIdentity({ name: 'a.b', version: '1.0.0-ballot+1' }, 'x'), { packageName: 'a.b', version: '1.0.0-ballot+1' });
  assert.throws(() => readPackageIdentity({ version: '1.0.0' }, '/p'), /package\.json of \/p has no valid "name"/);
  assert.throws(() => readPackageIdentity({ name: '../evil', version: '1.0.0' }, '/p'), /no valid "name"/);
  assert.throws(() => readPackageIdentity({ name: 'a.b', version: '1/../2' }, '/p'), /no valid "version"/);
});

test('installLocalPackage: .tgz is installed as <name>#<version>/package and replaces the cached copy', async (t) => {
  const dir = await tempDir(t);
  const packagesDir = path.join(dir, 'cache');
  const tgz = path.join(dir, 'package.tgz');
  await fs.writeFile(tgz, zlib.gzipSync(tarball([
    tarEntry('package/package.json', PACKAGE_JSON),
    tarEntry('package/.index.json', '{"files":[]}'),
    tarEntry('package/StructureDefinition-my-patient.json', PROFILE),
    tarEntry('package/example/Patient-1.json', '{"resourceType":"Patient"}'),
  ])));
  const stale = path.join(packagesDir, 'my.local.test#0.1.0-dev', 'package', 'StructureDefinition-old.json');
  await fs.outputFile(stale, '{}');

  const result = await installLocalPackage(tgz, { packagesDir });
  assert.equal(result.packageName, 'my.local.test');
  assert.equal(result.version, '0.1.0-dev');
  assert.equal(result.replaced, true);
  assert.equal(result.pkgDir, path.join(packagesDir, 'my.local.test#0.1.0-dev'));
  const target = path.join(result.pkgDir, 'package');
  assert.deepEqual((await fs.readdir(target)).sort(), ['StructureDefinition-my-patient.json', 'example', 'package.json']);
  assert.ok(await fs.pathExists(path.join(target, 'example', 'Patient-1.json')));
  assert.equal(await fs.pathExists(stale), false);
});

test('installLocalPackage: folder with package.json, or with a package/ subfolder', async (t) => {
  const dir = await tempDir(t);
  const packagesDir = path.join(dir, 'cache');

  const flat = path.join(dir, 'flat');
  await fs.outputFile(path.join(flat, 'package.json'), PACKAGE_JSON);
  await fs.outputFile(path.join(flat, 'StructureDefinition-my-patient.json'), PROFILE);
  await fs.outputFile(path.join(flat, 'node_modules', 'x', 'index.js'), '');
  let result = await installLocalPackage(flat, { packagesDir });
  assert.equal(result.replaced, false);
  assert.deepEqual((await fs.readdir(path.join(result.pkgDir, 'package'))).sort(), ['StructureDefinition-my-patient.json', 'package.json']);

  const nested = path.join(dir, 'nested');
  await fs.outputFile(path.join(nested, 'package', 'package.json'), PACKAGE_JSON.replace('0.1.0-dev', '0.2.0'));
  await fs.outputFile(path.join(nested, 'other.txt'), 'not part of the package');
  result = await installLocalPackage(nested, { packagesDir });
  assert.equal(result.version, '0.2.0');
  assert.deepEqual(await fs.readdir(path.join(result.pkgDir, 'package')), ['package.json']);

  // Pointing at the cache entry itself leaves it untouched.
  const again = await installLocalPackage(result.pkgDir, { packagesDir });
  assert.equal(again.replaced, false);
  assert.ok(await fs.pathExists(path.join(result.pkgDir, 'package', 'package.json')));
});

test('installLocalPackage: clear errors for unusable paths', async (t) => {
  const dir = await tempDir(t);
  const packagesDir = path.join(dir, 'cache');
  await assert.rejects(installLocalPackage(path.join(dir, 'missing'), { packagesDir }), /Local package not found/);

  const empty = path.join(dir, 'empty');
  await fs.ensureDir(empty);
  await assert.rejects(installLocalPackage(empty, { packagesDir }), /No package\.json found/);

  const txt = path.join(dir, 'package.zip');
  await fs.writeFile(txt, 'x');
  await assert.rejects(installLocalPackage(txt, { packagesDir }), /must be a folder or a \.tgz/);

  const evil = path.join(dir, 'evil.tgz');
  await fs.writeFile(evil, zlib.gzipSync(tarball([tarEntry('../outside.json', '{}')])));
  await assert.rejects(installLocalPackage(evil, { packagesDir }), /unsafe path/);
  assert.equal(await fs.pathExists(path.join(dir, 'outside.json')), false);
});
