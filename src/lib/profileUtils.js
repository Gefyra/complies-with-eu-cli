'use strict';

const fs = require('fs-extra');
const path = require('path');

const COMPLIES_WITH_URL =
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-compliesWithProfile';

/**
 * Scans all JSON files in <pkgDir>/package/ and returns the StructureDefinition
 * whose url matches the given canonical.
 */
async function findProfileByCanonical(pkgDir, canonical) {
  const packageSubdir = path.join(pkgDir, 'package');
  const exists = await fs.pathExists(packageSubdir);
  const searchDir = exists ? packageSubdir : pkgDir;

  const files = await fs.readdir(searchDir);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(searchDir, file);
    try {
      const json = await fs.readJson(filePath);
      if (json.resourceType === 'StructureDefinition' && json.url === canonical) {
        return { profile: json, filePath };
      }
    } catch {
      // Skip unparseable files
    }
  }
  throw new Error(
    `No StructureDefinition with url '${canonical}' found in ${searchDir}`
  );
}

/**
 * Scans all known EU package directories for StructureDefinitions of the given FHIR type.
 * Returns an array of canonical URLs.
 */
async function findEuProfilesByType(euPackageDirs, fhirType) {
  const profiles = [];
  for (const pkgDir of euPackageDirs) {
    const packageSubdir = path.join(pkgDir, 'package');
    const exists = await fs.pathExists(packageSubdir);
    const searchDir = exists ? packageSubdir : pkgDir;

    if (!await fs.pathExists(searchDir)) continue;

    const files = await fs.readdir(searchDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(searchDir, file);
      try {
        const json = await fs.readJson(filePath);
        if (
          json.resourceType === 'StructureDefinition' &&
          json.type === fhirType &&
          json.url
        ) {
          profiles.push({ url: json.url, version: json.version || null });
        }
      } catch {
        // Skip unparseable files
      }
    }
  }
  return profiles;
}

/**
 * Returns a new profile object with compliesWithProfile extensions added.
 * Does not mutate the original.
 */
function addCompliesWithExtensions(profile, canonicals) {
  const copy = JSON.parse(JSON.stringify(profile));
  if (!Array.isArray(copy.extension)) {
    copy.extension = [];
  }
  // Remove any pre-existing compliesWithProfile entries to avoid duplicates
  copy.extension = copy.extension.filter(e => e.url !== COMPLIES_WITH_URL);

  for (const canonical of canonicals) {
    copy.extension.push({
      url: COMPLIES_WITH_URL,
      valueCanonical: canonical,
    });
  }
  return copy;
}

/**
 * Builds a URL-safe slug from a canonical for use in filenames.
 * e.g. "http://example.org/fhir/StructureDefinition/MyProfile" → "MyProfile"
 */
function canonicalToSlug(canonical) {
  return canonical
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

const CONFORMANCE_RESOURCE_TYPES = new Set([
  'StructureDefinition', 'CodeSystem', 'ValueSet', 'SearchParameter',
  'CapabilityStatement', 'OperationDefinition', 'NamingSystem', 'ConceptMap',
  'ImplementationGuide', 'MessageDefinition', 'GraphDefinition',
  'CompartmentDefinition', 'ExampleScenario', 'TestScript',
]);

/**
 * Scans a package directory for example instances of the given FHIR resource type.
 * Looks first in <pkgDir>/package/example/ (or examples/), then falls back to
 * scanning <pkgDir>/package/ for non-conformance resources of the target type.
 *
 * @param {string} pkgDir   - Root of the resolved FHIR package (e.g. ~/.fhir/packages/name#ver)
 * @param {string} fhirType - FHIR resource type to look for (e.g. "Patient")
 * @returns {Promise<Array<{json: object, filePath: string, fileName: string}>>}
 */
async function findExamplesInPackage(pkgDir, fhirType) {
  const packageSubdir = path.join(pkgDir, 'package');
  const pkgExists = await fs.pathExists(packageSubdir);
  const baseDir = pkgExists ? packageSubdir : pkgDir;

  // 1. Prefer dedicated example subdirectory
  const exampleDirCandidates = ['example', 'examples'];
  let exampleDir = null;
  for (const sub of exampleDirCandidates) {
    const candidate = path.join(baseDir, sub);
    if (await fs.pathExists(candidate)) {
      exampleDir = candidate;
      break;
    }
  }

  const searchDir = exampleDir ?? baseDir;
  const files = await fs.readdir(searchDir);
  const examples = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(searchDir, file);
    try {
      const json = await fs.readJson(filePath);
      if (
        json.resourceType === fhirType &&
        !CONFORMANCE_RESOURCE_TYPES.has(json.resourceType)
      ) {
        examples.push({ json, filePath, fileName: file });
      }
    } catch {
      // Skip unparseable files
    }
  }

  return examples;
}

/**
 * Returns a new resource object with meta.profile claims added for the given canonicals.
 * Existing meta.profile entries are preserved. Does not mutate the original.
 *
 * @param {object}   resource   - FHIR resource instance
 * @param {string[]} canonicals - EU profile canonical URLs to add
 * @returns {object}
 */
function addMetaProfileClaims(resource, canonicals) {
  const copy = JSON.parse(JSON.stringify(resource));
  if (!copy.meta) copy.meta = {};
  if (!Array.isArray(copy.meta.profile)) copy.meta.profile = [];
  for (const c of canonicals) {
    if (!copy.meta.profile.includes(c)) {
      copy.meta.profile.push(c);
    }
  }
  return copy;
}

/**
 * Scans a package directory and returns all StructureDefinitions found.
 * Returns an array of { url, name, id, type } objects.
 */
async function findAllProfilesInPackage(pkgDir) {
  const packageSubdir = path.join(pkgDir, 'package');
  const exists = await fs.pathExists(packageSubdir);
  const searchDir = exists ? packageSubdir : pkgDir;

  const files = await fs.readdir(searchDir);
  const profiles = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(searchDir, file);
    try {
      const json = await fs.readJson(filePath);
      if (json.resourceType === 'StructureDefinition' && json.url) {
        profiles.push({ url: json.url, name: json.name, id: json.id, type: json.type, kind: json.kind });
      }
    } catch {
      // Skip unparseable files
    }
  }
  return profiles;
}

module.exports = {
  findProfileByCanonical,
  findEuProfilesByType,
  findAllProfilesInPackage,
  addCompliesWithExtensions,
  canonicalToSlug,
  findExamplesInPackage,
  addMetaProfileClaims,
};
