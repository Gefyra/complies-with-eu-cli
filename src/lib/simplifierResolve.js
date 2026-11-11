'use strict';

const axios = require('axios');

/**
 * Queries the Simplifier.net canonical resolve page and returns a list of
 * packages that contain (or claim) the given canonical URL.
 *
 * @param {string} canonical  The canonical URL to look up.
 * @returns {Promise<Array<{packageId: string, canonical: string, matchType: string}>>}
 */
async function resolveCanonicalOnSimplifier(canonical) {
  const url = `https://simplifier.net/resolve?scope=&canonical=${encodeURIComponent(canonical)}`;

  const { data: html } = await axios.get(url, {
    headers: { 'User-Agent': 'complies-with-eu-cli/1.0' },
    timeout: 15000,
  });

  const results = [];

  // Each result row: <tr> ... <a href="/packages/name/version">name@version</a> ...
  // followed by the canonical td and a match-type span.
  // We split on <tr> boundaries and parse each row.
  const rows = html.split(/<\/tr>/i);

  const packageLinkRegex = /href="\/packages\/[^"]+"\s*>\s*([\s\S]*?)<\/a>/;
  const matchTypeRegex = /<span class="value [^"]*">(claimed [^<]+)<\/span>/;
  const canonicalLinkRegex = /href="\/resolve\?[^"]*canonical=([^&"]+)/;

  for (const row of rows) {
    if (!row.includes('/packages/')) continue;

    const pkgMatch = packageLinkRegex.exec(row);
    if (!pkgMatch) continue;

    const packageId = pkgMatch[1].trim();
    if (!packageId.includes('@')) continue;

    const matchTypeMatch = matchTypeRegex.exec(row);
    const matchType = matchTypeMatch ? matchTypeMatch[1].trim() : 'unknown';

    const canonicalMatch = canonicalLinkRegex.exec(row);
    const resolvedCanonical = canonicalMatch
      ? decodeURIComponent(canonicalMatch[1])
      : canonical;

    results.push({ packageId, canonical: resolvedCanonical, matchType });
  }

  return results;
}

module.exports = { resolveCanonicalOnSimplifier };
