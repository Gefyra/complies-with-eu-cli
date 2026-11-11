'use strict';

const fs = require('fs-extra');
const path = require('path');

const OBLIGATION_URL = 'http://hl7.org/fhir/StructureDefinition/obligation';

/**
 * Parses the obligation code string (e.g. "SHALL:able-to-populate") into
 * { strength: "SHALL", code: "able-to-populate" }.
 *
 * @param {string} codeValue
 * @returns {{ strength: string, code: string }}
 */
function parseObligationCode(codeValue) {
  const colonIdx = codeValue.indexOf(':');
  if (colonIdx === -1) return { strength: codeValue, code: '' };
  return {
    strength: codeValue.slice(0, colonIdx),
    code: codeValue.slice(colonIdx + 1),
  };
}

/**
 * Strength ordering: SHALL > SHOULD > MAY
 * Returns true if the given strength is "at least SHALL" (exact match for now,
 * since SHALL is the highest).
 */
function isRelevantStrength(strength) {
  return strength === 'SHALL' || strength === 'SHOULD';
}

/**
 * Loads a StructureDefinition from a package directory by canonical URL.
 * Searches in <pkgDir>/package/ first, then <pkgDir>/.
 *
 * @param {string} pkgDir
 * @param {string} canonical
 * @returns {Promise<object|null>}
 */
async function loadProfileByCanonical(pkgDir, canonical) {
  const packageSubdir = path.join(pkgDir, 'package');
  const exists = await fs.pathExists(packageSubdir);
  const searchDir = exists ? packageSubdir : pkgDir;

  const files = await fs.readdir(searchDir);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const json = await fs.readJson(path.join(searchDir, file));
      if (json.resourceType === 'StructureDefinition' && json.url === canonical) {
        return json;
      }
    } catch {
      // skip unparseable
    }
  }
  return null;
}

/**
 * Strips the slice name from an element id/path, e.g.
 *   "Condition.category:poa" → "Condition.category"
 *   "Condition.onset[x]:onsetDateTime" → "Condition.onset[x]"
 */
function stripSlice(id) {
  return id.replace(/:[^.[\]]+/g, '');
}

/**
 * Builds a lookup map of path/id → element from a StructureDefinition's snapshot.
 * Prefers id over path for the key.
 *
 * @param {object} sd - StructureDefinition JSON
 * @returns {Map<string, object>}
 */
function buildSnapshotMap(sd) {
  const map = new Map();
  for (const el of (sd.snapshot?.element ?? [])) {
    if (el.id) map.set(el.id, el);
    if (el.path && !map.has(el.path)) map.set(el.path, el);
  }
  return map;
}

/**
 * Finds the best-matching element in an input profile's snapshot for a given EU element.
 * Resolution order:
 *   1. Exact id match
 *   2. Slice-stripped id match
 *   3. Exact path match (handles EU profiles that use the profile name instead of the
 *      FHIR type in element IDs, e.g. "PatientEuBase.identifier" vs "Patient.identifier")
 *   4. Slice-stripped path match
 *
 * @param {Map<string,object>} snapshotMap
 * @param {string} euElementId   - e.g. "PatientEuBase.identifier" or "Condition.category:poa"
 * @param {string} [euElementPath] - e.g. "Patient.identifier" (always type-based in FHIR)
 * @returns {{ element: object|null, matchType: string }}
 */
function findInputElement(snapshotMap, euElementId, euElementPath) {
  // 1. Exact id
  if (snapshotMap.has(euElementId)) {
    return { element: snapshotMap.get(euElementId), matchType: 'exact' };
  }
  // 2. Slice-stripped id
  const baseId = stripSlice(euElementId);
  if (snapshotMap.has(baseId)) {
    return { element: snapshotMap.get(baseId), matchType: 'baseId' };
  }
  // 3. Exact path — EU profiles often use the profile name in element IDs
  //    (e.g. "PatientEuBase.identifier") while input snapshots use the FHIR type
  //    ("Patient.identifier"); the path field is always type-based.
  if (euElementPath && snapshotMap.has(euElementPath)) {
    return { element: snapshotMap.get(euElementPath), matchType: 'path' };
  }
  // 4. Slice-stripped path
  if (euElementPath) {
    const basePath = stripSlice(euElementPath);
    if (snapshotMap.has(basePath)) {
      return { element: snapshotMap.get(basePath), matchType: 'basePath' };
    }
  }
  return { element: null, matchType: 'notFound' };
}

/**
 * Checks all SHALL:able-to-populate obligations in an EU profile's differential
 * against the corresponding elements in the input profile's snapshot.
 *
 * Returns an array of violation objects.
 *
 * @param {string}   inputPkgDir          - Root directory of the input package
 * @param {string}   inputCanonical
 * @param {string[]} euPkgDirs            - All EU package directories to search for the EU profile
 * @param {string}   euCanonical
 * @returns {Promise<Array<{...}>>}
 */
async function checkObligations(inputPkgDir, inputCanonical, euPkgDirs, euCanonical) {
  // Search for the EU profile across all EU package directories
  let euSd = null;
  for (const dir of (Array.isArray(euPkgDirs) ? euPkgDirs : [euPkgDirs])) {
    euSd = await loadProfileByCanonical(dir, euCanonical);
    if (euSd) break;
  }

  const inputSd = await loadProfileByCanonical(inputPkgDir, inputCanonical);

  if (!inputSd || !euSd) return [];

  const snapshotMap = buildSnapshotMap(inputSd);
  const violations = [];

  for (const euEl of (euSd.differential?.element ?? [])) {
    const oblExts = (euEl.extension ?? []).filter(e => e.url === OBLIGATION_URL);
    for (const obl of oblExts) {
      const codeValue = obl.extension?.find(e => e.url === 'code')?.valueCode ?? '';
      const { strength, code } = parseObligationCode(codeValue);

      if (code !== 'able-to-populate') continue;
      if (!isRelevantStrength(strength)) continue;

      const actor = obl.extension?.find(e => e.url === 'actor')?.valueCanonical ?? null;

      const { element: inputEl, matchType } = findInputElement(snapshotMap, euEl.id, euEl.path);
      const inputMin = inputEl?.min ?? null;
      const inputMax = inputEl?.max ?? null;
      const inputCardinality = inputEl ? `${inputMin ?? '?'}..${inputMax ?? '?'}` : null;
      const inputMustSupport = inputEl?.mustSupport === true;

      const maxIsZero = inputMax === '0';
      const missingMustSupport = !inputMustSupport;

      // Only report if there's at least one problem
      if (missingMustSupport || maxIsZero || matchType === 'notFound') {
        violations.push({
          euElementId: euEl.id,
          obligationCode: codeValue,
          strength,
          actor,
          inputElementId: inputEl?.id ?? null,
          matchType,
          missingMustSupport,
          maxIsZero,
          inputCardinality,
          inputMustSupport,
        });
      }
    }
  }

  return violations;
}

module.exports = { checkObligations, loadProfileByCanonical };
