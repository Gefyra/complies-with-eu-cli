import { loadProfileByCanonical } from './obligationCheck.js';

/**
 * Parses an expression of the form `A.exists() or B.exists() or extension('url').exists() or …`.
 * Returns null if the expression contains anything other than pure `.exists() or …` terms.
 *
 * @param {string} expr
 * @returns {{ paths: string[], extensionUrls: string[] } | null}
 */
function parseExistsOrExpression(expr) {
  const normalized = expr.replace(/\s+/g, ' ').trim();
  const terms = normalized.split(/\s+or\s+/);
  const paths = [];
  const extensionUrls = [];

  const pathRe = /^([A-Za-z_][A-Za-z0-9_.]*)\.exists\(\)$/;
  const extRe = /^extension\(\s*'([^']+)'\s*\)\.exists\(\)$/;

  for (const term of terms) {
    const pm = term.match(pathRe);
    if (pm) { paths.push(pm[1]); continue; }
    const em = term.match(extRe);
    if (em) { extensionUrls.push(em[1]); continue; }
    // Unknown term – reject entire expression
    return null;
  }

  if (paths.length === 0 && extensionUrls.length === 0) return null;
  return { paths, extensionUrls };
}

/**
 * Searches for the first element in the EU SD snapshot/differential whose constraints
 * contain the given expression and returns its path.
 *
 * @param {object} euSd
 * @param {string} expr
 * @returns {string | null}
 */
function findConstraintBasePath(euSd, expr) {
  const elementSets = [
    euSd.snapshot?.element ?? [],
    euSd.differential?.element ?? [],
  ];
  for (const elements of elementSets) {
    for (const el of elements) {
      for (const c of (el.constraint ?? [])) {
        if (c.expression === expr) return el.path;
      }
    }
  }
  return null;
}

/**
 * Returns the distinct element paths of the EU SD that declare a constraint with
 * the given expression (snapshot; the differential only when there is no snapshot).
 *
 * @param {object} euSd
 * @param {string} expr
 * @returns {string[]}
 */
function findConstraintPaths(euSd, expr) {
  const snapshotEls = euSd?.snapshot?.element ?? [];
  const elements = snapshotEls.length > 0 ? snapshotEls : (euSd?.differential?.element ?? []);
  const paths = new Set();
  for (const el of elements) {
    if ((el.constraint ?? []).some(c => c.expression === expr) && el.path) paths.add(el.path);
  }
  return [...paths];
}

/**
 * Checks whether at least one term of `{ paths, extensionUrls }` is structurally guaranteed
 * by `min >= 1` in the input SD's elements under `basePath`.
 *
 * Deliberately conservative (a false "satisfied" would hide a real non-compliance):
 * - Only unsliced elements count for path terms (an element that is required only
 *   inside an optional slice does not guarantee anything).
 * - A path term must match the full relative path ("family" → <basePath>.family,
 *   "name.family" → <basePath>.name and <basePath>.name.family, each with min >= 1).
 * - An extension term needs an extension slice directly on <basePath>.extension with
 *   min >= 1 whose type profile (or fixed/pattern url) is the extension URL.
 *
 * @param {object}   inputSd
 * @param {string}   basePath   - e.g. "Patient.name"
 * @param {{ paths: string[], extensionUrls: string[] }} parsed
 * @returns {{ satisfied: boolean, matchedChild: string | null }}
 */
function isSatisfiedInInputSnapshot(inputSd, basePath, { paths = [], extensionUrls = [] }) {
  // Many IGs ship without a snapshot – fall back to the differential in that case.
  const snapshotEls = inputSd.snapshot?.element ?? [];
  const elements = snapshotEls.length > 0
    ? snapshotEls
    : (inputSd.differential?.element ?? []);

  const isUnsliced = (el) => !el.sliceName && !(el.id ?? '').includes(':');
  const requiredUnsliced = (p) => elements.find(el => el.path === p && isUnsliced(el) && (el.min ?? 0) >= 1);

  // Plain path terms
  for (const term of paths) {
    const segments = term.split('.');
    let current = basePath;
    let lastEl = null;
    let ok = true;
    for (const seg of segments) {
      current = `${current}.${seg}`;
      lastEl = requiredUnsliced(current);
      if (!lastEl) { ok = false; break; }
    }
    if (ok && lastEl) {
      return { satisfied: true, matchedChild: `${lastEl.path} (min: ${lastEl.min})` };
    }
  }

  // Extension URL terms
  if (extensionUrls.length > 0) {
    const extPath = `${basePath}.extension`;
    for (const el of elements) {
      if (el.path !== extPath || (el.min ?? 0) < 1) continue;
      // Only the extension slice itself may be sliced, not an ancestor (e.g. "Patient.name:official.extension:x")
      if ((el.id ?? '').split(':').length > 2) continue;
      for (const url of extensionUrls) {
        const typeProfiles = (el.type ?? []).flatMap(t => t.profile ?? []);
        if (typeProfiles.includes(url) || el.fixedUri === url || el.patternUri === url) {
          return { satisfied: true, matchedChild: `${el.id || el.path} (min: ${el.min})` };
        }
      }
    }
  }

  return { satisfied: false, matchedChild: null };
}

/**
 * Returns true if the path is an extension path, e.g. "extension",
 * "Condition.extension" or "Condition.extension:assertedDate".
 *
 * @param {string} p
 * @returns {boolean}
 */
function isExtensionPath(p) {
  // Matches paths like "extension", "Condition.extension", "Condition.extension:assertedDate"
  return /(?:^|\.)extension(?:[.:]|$)/i.test(p);
}

/**
 * Returns true if a detail line describes a "no slicing found" mismatch on an
 * extension path. Those are ignored because extension slicing is open.
 *
 * @param {string} detail
 * @returns {boolean}
 */
function isIgnoredSlicingDetail(detail) {
  const text = detail.replace(/^slice error:\s*/i, '').trim();
  const mismatchMatch = text.match(/Mismatch in slicing at (\S+):/i);
  return mismatchMatch ? isExtensionPath(mismatchMatch[1]) : false;
}

const TYPE_SLICE_MISMATCH = /Mismatch in slicing at (\S+): no slice found for the discriminator type:\$this with the values (\S+?)\.?$/i;

const maxRank = (m) => (m === '*' || m === undefined || m === null ? Infinity : Number(m));

/**
 * Decides whether a "no slice found for the discriminator type:$this" detail is
 * only a narrowing of the claimed profile, i.e. compliant (pure, for tests).
 *
 * HL7 FHIR Validator 7.x reports this message when the claimed (EU) profile has
 * a type slice (e.g. Observation.value[x]:valueBoolean) and the derived profile
 * neither has that slice nor allows the type. Verified experimentally: allowing
 * the type again, adding the slice, or declaring it with max 0 removes the
 * message, while real loosening is reported with different messages
 * (cardinality, snapshot errors for types the claimed profile does not allow).
 *
 * Resolved only when all of these hold (conservative):
 *  - the claimed profile's slice is optional (min = 0),
 *  - the type is not among the derived element's allowed types,
 *  - the derived element is not looser than the claimed one (min/max),
 *  - the validator generated the snapshot without errors (`snapshotOk`).
 *
 * @returns {null | { kind: 'type-slice', euCanonical, basePath, sliceName, type, expression, matchedChild }}
 */
function resolveTypeSliceDetail(detail, { inputSd, euSd, euCanonical, snapshotOk = true }) {
  if (!snapshotOk || !inputSd || !euSd) return null;
  const text = String(detail).replace(/^slice error:\s*/i, '').trim();
  const m = text.match(TYPE_SLICE_MISMATCH);
  if (!m) return null;
  const sep = m[1].lastIndexOf(':');
  if (sep <= 0) return null;
  const elementPath = m[1].slice(0, sep);
  const sliceName = m[1].slice(sep + 1);
  const type = m[2];

  const euElements = euSd.snapshot?.element || [];
  const euSlice = euElements.find(e => e.id === `${elementPath}:${sliceName}` || (e.path === elementPath && e.sliceName === sliceName));
  const euBase = euElements.find(e => e.id === elementPath);
  if (!euSlice || euSlice.min !== 0) return null;

  const derived = (inputSd.snapshot?.element || []).find(e => e.id === elementPath);
  if (!derived || !Array.isArray(derived.type)) return null;
  const allowed = derived.type.map(t => t.code);
  if (allowed.includes(type)) return null;
  if (euBase) {
    if ((derived.min ?? 0) < (euBase.min ?? 0)) return null;
    if (maxRank(derived.max) > maxRank(euBase.max)) return null;
  }

  return {
    kind: 'type-slice',
    euCanonical,
    basePath: `${elementPath}:${sliceName}`,
    sliceName,
    type,
    expression: text,
    matchedChild: `type ${type} is not allowed here (allowed: ${allowed.join(', ')}); the EU slice is optional (${euSlice.min}..${euSlice.max ?? '*'})`,
  };
}

/**
 * Evaluates all `SD_EXTENSION_COMPLIES_WITH_ERROR` issues for pure `exists() or …` constraints
 * and returns a filtered nonCompliantMap plus a list of satisfied (auto-resolved) constraints.
 * Missing optional type slices whose type the input profile does not allow are
 * resolved as well (see resolveTypeSliceDetail); those items carry kind 'type-slice'.
 *
 * `unresolved` records, for every `exists() or …` constraint that stays in the map,
 * why it was not resolved:
 * - 'unsatisfied': evaluated; the input's minimum cardinalities do not guarantee it
 * - 'noEuSd':      the claimed EU StructureDefinition was not loaded, so it was not evaluated
 * - 'noBasePath':  no element of the EU SD declares the constraint, so it was not evaluated
 *
 * @param {object} opts
 * @param {object}   opts.inputSd              - The input StructureDefinition object
 * @param {Map}      opts.euSdByCanonical       - Map of euCanonical → euSd (pre-loaded)
 * @param {Map}      opts.nonCompliantMap       - Map of euCanonical → detail string[]
 * @param {boolean}  [opts.snapshotOk=true]     - false if the validator reported snapshot generation errors
 * @returns {{ filteredMap: Map, satisfied: Array, unresolved: Array<{ euCanonical: string, expression: string, reason: string }> }}
 */
function evaluateExistsOrConstraints({ inputSd, euSdByCanonical, nonCompliantMap, snapshotOk = true }) {
  const filteredMap = new Map();
  const satisfied = [];
  const unresolved = [];

  for (const [euCanonical, details] of nonCompliantMap) {
    // Strip version suffix (e.g. "|2.0.0-recon") for SD lookup
    const euCanonicalUrl = euCanonical.split('|')[0];
    const euSd = euSdByCanonical.get(euCanonicalUrl);
    const remainingDetails = [];

    for (const detail of details) {
      if (isIgnoredSlicingDetail(detail)) continue;

      const typeSlice = resolveTypeSliceDetail(detail, { inputSd, euSd, euCanonical, snapshotOk });
      if (typeSlice) {
        satisfied.push(typeSlice);
        continue;
      }

      const constraintMatch = detail.match(
        /The constraint '(.+)' is defined in the claimed profile, but missing/
      );
      if (!constraintMatch) {
        remainingDetails.push(detail);
        continue;
      }

      const expr = constraintMatch[1];
      const parsed = parseExistsOrExpression(expr);
      if (!parsed) {
        remainingDetails.push(detail);
        continue;
      }

      if (!euSd) {
        remainingDetails.push(detail);
        unresolved.push({ euCanonical, expression: expr, reason: 'noEuSd' });
        continue;
      }

      const basePath = findConstraintBasePath(euSd, expr);
      if (!basePath) {
        remainingDetails.push(detail);
        unresolved.push({ euCanonical, expression: expr, reason: 'noBasePath' });
        continue;
      }

      const { satisfied: isSat, matchedChild } = isSatisfiedInInputSnapshot(inputSd, basePath, parsed);
      if (isSat) {
        satisfied.push({ euCanonical, expression: expr, basePath, matchedChild });
      } else {
        remainingDetails.push(detail);
        unresolved.push({ euCanonical, expression: expr, reason: 'unsatisfied' });
      }
    }

    if (remainingDetails.length > 0) {
      filteredMap.set(euCanonical, remainingDetails);
    }
  }

  return { filteredMap, satisfied, unresolved };
}

/**
 * Loads the EU SDs needed for constraint checking from package directories.
 *
 * @param {string[]} euPkgDirs
 * @param {string[]} euCanonicals
 * @returns {Promise<Map<string, object>>}
 */
async function loadEuSds(euPkgDirs, euCanonicals) {
  const map = new Map();
  for (const canonical of euCanonicals) {
    for (const dir of euPkgDirs) {
      const sd = await loadProfileByCanonical(dir, canonical);
      if (sd) { map.set(canonical, sd); break; }
    }
  }
  return map;
}

export {
  evaluateExistsOrConstraints,
  loadEuSds,
  parseExistsOrExpression,
  findConstraintBasePath,
  findConstraintPaths,
  isSatisfiedInInputSnapshot,
  isIgnoredSlicingDetail,
  resolveTypeSliceDetail,
};
