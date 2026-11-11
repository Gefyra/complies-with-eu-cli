'use strict';

const path = require('path');
const fs = require('fs-extra');

/**
 * Loads a package-level mapping.json file from the package workdir.
 * Returns the mapping object { package, mappings: { [canonical]: string[] } } or null if not found.
 *
 * @param {string} pkgWorkdir - The package-specific workdir (e.g. workdir/kbv-basis-1-8-0)
 * @returns {Promise<{package: string, mappings: object}|null>}
 */
async function loadPackageMapping(pkgWorkdir) {
  const mappingPath = path.join(pkgWorkdir, 'mapping.json');
  if (!await fs.pathExists(mappingPath)) return null;
  try {
    return await fs.readJson(mappingPath);
  } catch {
    return null;
  }
}

/**
 * Saves a package-level mapping.json file to the package workdir.
 *
 * @param {string} pkgWorkdir - The package-specific workdir
 * @param {string} packageSpec - e.g. "kbv.basis@1.8.0"
 * @param {object} mappings - { [canonical]: string[] } mapping of profile canonicals to EU canonical arrays
 * @returns {Promise<void>}
 */
async function savePackageMapping(pkgWorkdir, packageSpec, mappings) {
  const mappingPath = path.join(pkgWorkdir, 'mapping.json');
  const data = {
    package: packageSpec,
    mappings,
  };
  await fs.ensureDir(pkgWorkdir);
  await fs.writeJson(mappingPath, data, { spaces: 2 });
}

/**
 * Loads an external mapping file specified via --mapping <file>.
 * Returns the mapping object { package, mappings: { [canonical]: string[] } } or throws if invalid.
 *
 * @param {string} filePath - Absolute or relative path to the mapping file
 * @returns {Promise<{package: string, mappings: object}>}
 */
async function loadExternalMapping(filePath) {
  if (!await fs.pathExists(filePath)) {
    throw new Error(`Mapping file not found: ${filePath}`);
  }
  const data = await fs.readJson(filePath);
  if (!data.package || typeof data.mappings !== 'object') {
    throw new Error(`Invalid mapping file format: ${filePath} (must have "package" and "mappings" fields)`);
  }
  return data;
}

module.exports = {
  loadPackageMapping,
  savePackageMapping,
  loadExternalMapping,
};
