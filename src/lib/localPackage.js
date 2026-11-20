import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import fs from 'fs-extra';
import { getFhirPackagesDir } from './fhirPkgTool.js';

/**
 * Support for `validate-batch --local <path>`: a FHIR package that lies somewhere
 * on disk (for example the `package.tgz` an IG build produced) instead of in a
 * registry. The package is copied into the FHIR package cache
 * (~/.fhir/packages/<name>#<version>), where fhir-pkg-tool and the HL7 validator
 * find it like any downloaded package.
 */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const ARCHIVE_RE = /\.(tgz|tar\.gz|tar)$/i;
/** Never copied from a local package folder. */
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

/**
 * Reads the entries of a tar archive (pure, for tests). Supports the formats
 * `npm pack` and the IG publisher write: ustar with prefix, GNU long names and
 * pax `path` records. Only regular files are returned.
 * @param {Buffer} buf - uncompressed tar data
 * @returns {Array<{ name: string, data: Buffer }>}
 */
function readTarEntries(buf) {
  const entries = [];
  const text = (start, len) => {
    const slice = buf.subarray(start, start + len);
    const end = slice.indexOf(0);
    return slice.subarray(0, end === -1 ? len : end).toString('utf8');
  };
  let offset = 0;
  let longName = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('Invalid tar archive (bad size field).');
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    if (dataStart + size > buf.length) throw new Error('Invalid tar archive (truncated).');
    const data = buf.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') { // GNU long name for the next entry
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x') { // pax header for the next entry
      const m = data.toString('utf8').match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      if (m) longName = m[1];
      continue;
    }
    if (type === 'g') continue; // pax global header
    const prefix = text(dataStart - 512 + 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${text(dataStart - 512, 100)}` : text(dataStart - 512, 100));
    longName = null;
    if (type === '0') entries.push({ name, data });
  }
  return entries;
}

/**
 * Turns an archive entry name into a safe relative path, or null when it would
 * leave the target directory (pure, for tests).
 */
function safeEntryPath(name) {
  const normalized = String(name).replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split('/').filter(p => p !== '' && p !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return parts.join('/');
}

/** Extracts a .tgz / .tar.gz / .tar archive into `targetDir`. */
async function extractArchive(archivePath, targetDir) {
  let buf = await fs.readFile(archivePath);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  for (const entry of readTarEntries(buf)) {
    const rel = safeEntryPath(entry.name);
    if (!rel) throw new Error(`Archive contains an unsafe path: ${entry.name}`);
    await fs.outputFile(path.join(targetDir, rel), entry.data);
  }
}

/**
 * Finds the folder that holds package.json: the directory itself or its
 * `package/` subfolder (the layout inside a package.tgz and the package cache).
 */
async function findPackageFolder(dir) {
  for (const candidate of [path.join(dir, 'package'), dir]) {
    if (await fs.pathExists(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/**
 * Checks the name and version of a package.json (pure, for tests).
 * @returns {{ packageName: string, version: string }}
 */
function readPackageIdentity(meta, source) {
  const name = meta && typeof meta.name === 'string' ? meta.name.trim() : '';
  const version = meta && typeof meta.version === 'string' ? meta.version.trim() : '';
  if (!NAME_RE.test(name)) throw new Error(`The package.json of ${source} has no valid "name".`);
  if (!VERSION_RE.test(version)) throw new Error(`The package.json of ${source} has no valid "version".`);
  return { packageName: name, version };
}

/**
 * Installs a local FHIR package (folder or .tgz) into the FHIR package cache,
 * replacing a cached package with the same name and version.
 * @param {string} localPath - package folder (with package.json, or with a `package/` subfolder) or a .tgz / .tar.gz / .tar file
 * @param {{ packagesDir?: string }} [opts] - cache directory (default: ~/.fhir/packages)
 * @returns {Promise<{ packageName: string, version: string, pkgDir: string, replaced: boolean, source: string }>}
 */
async function installLocalPackage(localPath, { packagesDir = getFhirPackagesDir() } = {}) {
  const source = path.resolve(String(localPath));
  let stat;
  try {
    stat = await fs.stat(source);
  } catch {
    throw new Error(`Local package not found: ${source}`);
  }

  let tempDir = null;
  try {
    let searchDir = source;
    if (stat.isFile()) {
      if (!ARCHIVE_RE.test(source)) {
        throw new Error(`Local package must be a folder or a .tgz / .tar.gz / .tar file: ${source}`);
      }
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwe-local-'));
      try {
        await extractArchive(source, tempDir);
      } catch (err) {
        throw new Error(`Could not read the package archive ${source}: ${err.message}`, { cause: err });
      }
      searchDir = tempDir;
    }

    const folder = await findPackageFolder(searchDir);
    if (!folder) {
      throw new Error(`No package.json found in ${source} (expected package.json or package/package.json).`);
    }
    let meta;
    try {
      meta = await fs.readJson(path.join(folder, 'package.json'));
    } catch (err) {
      throw new Error(`Could not read the package.json of ${source}: ${err.message}`, { cause: err });
    }
    const { packageName, version } = readPackageIdentity(meta, source);

    const pkgDir = path.join(packagesDir, `${packageName}#${version}`);
    const target = path.join(pkgDir, 'package');
    // The local path may already be the cache entry itself: nothing to copy then.
    if (path.resolve(folder).toLowerCase() === path.resolve(target).toLowerCase()) {
      return { packageName, version, pkgDir, replaced: false, source };
    }
    const replaced = await fs.pathExists(pkgDir);
    await fs.remove(pkgDir);
    await fs.copy(folder, target, {
      filter: (src) => !SKIPPED_DIRS.has(path.basename(src)) || path.resolve(src) === path.resolve(folder),
    });
    // The index of the source lists its files before snapshots were added; let the tools rebuild it.
    await fs.remove(path.join(target, '.index.json'));
    return { packageName, version, pkgDir, replaced, source };
  } finally {
    if (tempDir) await fs.remove(tempDir).catch(() => {});
  }
}

export { installLocalPackage, readTarEntries, safeEntryPath, readPackageIdentity };
