'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const { pipeline } = require('stream/promises');
const { CliError } = require('./errors');

const VERSIONS_FILE = 'versions.json';

/** Hosts that may receive the GITHUB_TOKEN. Redirect targets (CDN) never do. */
const GITHUB_HOSTS = new Set(['github.com', 'api.github.com']);

function githubHeaders(url, env = process.env) {
  const headers = { 'User-Agent': 'complies-with-eu' };
  let host = '';
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  if (env.GITHUB_TOKEN && GITHUB_HOSTS.has(host)) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

/** Drops the Authorization header when a redirect leaves the GitHub hosts. */
function stripAuthOnForeignRedirect(options) {
  if (!GITHUB_HOSTS.has(options.hostname) && options.headers) {
    delete options.headers.Authorization;
    delete options.headers.authorization;
  }
}

/**
 * Turns an axios/network error into an actionable message.
 */
function describeDownloadError(err, url) {
  const status = err.response && err.response.status;
  if (status === 403 || status === 429) {
    return `GitHub refused the request (HTTP ${status}, probably rate limited) for ${url}. ` +
      'Set GITHUB_TOKEN to a GitHub token to raise the limit and retry.';
  }
  if (status === 404) return `Not found (HTTP 404): ${url}. Check the version in tools.json or the override environment variable.`;
  if (status) return `HTTP ${status} while downloading ${url}`;
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(err.code)) {
    return `Network error (${err.code}) while downloading ${url}. Check your internet connection and proxy settings, then retry.`;
  }
  return `${err.message} (${url})`;
}

/** Computes the SHA-256 hex digest of a file. */
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Downloads `url` to `destPath` via `<destPath>.part`, optionally verifies the
 * SHA-256 checksum, then renames. A failed or aborted download never leaves a
 * file at destPath.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {object} [opts]
 * @param {string|null} [opts.sha256] - Expected hex digest; null skips the check
 */
async function downloadFile(url, destPath, { sha256 = null } = {}) {
  const partPath = `${destPath}.part`;
  await fs.ensureDir(path.dirname(destPath));
  await fs.remove(partPath);
  try {
    let response;
    try {
      response = await axios.get(url, {
        responseType: 'stream',
        headers: githubHeaders(url),
        beforeRedirect: stripAuthOnForeignRedirect,
        timeout: 60_000,
        maxRedirects: 10,
      });
    } catch (err) {
      throw new Error(describeDownloadError(err, url));
    }
    try {
      await pipeline(response.data, fs.createWriteStream(partPath));
    } catch (err) {
      throw new Error(describeDownloadError(err, url));
    }
    if (sha256) {
      const actual = await sha256File(partPath);
      if (actual.toLowerCase() !== sha256.toLowerCase()) {
        throw new Error(
          `Checksum mismatch for ${path.basename(destPath)} from ${url}: expected sha256 ${sha256}, got ${actual}. ` +
          'The download was discarded.'
        );
      }
    }
    await fs.move(partPath, destPath, { overwrite: true });
  } finally {
    await fs.remove(partPath).catch(() => {});
  }
}

/** Looks up the latest GitHub release asset matching assetPattern. */
async function getLatestReleaseAsset(repo, assetPattern) {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  let response;
  try {
    response = await axios.get(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', ...githubHeaders(apiUrl) },
      timeout: 30_000,
    });
  } catch (err) {
    throw new Error(describeDownloadError(err, apiUrl));
  }
  const assets = response.data.assets || [];
  const re = new RegExp(assetPattern, 'i');
  const asset = assets.find(a => re.test(a.name));
  if (!asset) {
    throw new Error(
      `No asset matching ${assetPattern} in the latest release of ${repo}. ` +
      `Available: ${assets.map(a => a.name).join(', ') || '(none)'}`
    );
  }
  return { url: asset.browser_download_url, version: response.data.tag_name };
}

/**
 * Decides which version/URL/checksum to install for a tool (pure, for tests).
 * An override (from tool.versionEnv) of "latest" or an explicit version disables
 * the checksum check.
 *
 * @param {object} tool - Entry from tools.json
 * @param {object} [env=process.env]
 * @returns {{ version: string|null, url: string|null, sha256: string|null, pinned: boolean, latest: boolean, override: string|null }}
 */
function resolveToolSpec(tool, env = process.env) {
  const override = tool.versionEnv && env[tool.versionEnv] ? String(env[tool.versionEnv]).trim() : '';
  if (!override || override === tool.version) {
    return { version: tool.version, url: tool.url, sha256: tool.sha256 || null, pinned: true, latest: false, override: null };
  }
  if (override.toLowerCase() === 'latest') {
    return { version: null, url: null, sha256: null, pinned: false, latest: true, override };
  }
  return {
    version: override,
    url: tool.urlTemplate ? tool.urlTemplate.replace('{version}', encodeURIComponent(override)) : null,
    sha256: null,
    pinned: false,
    latest: false,
    override,
  };
}

async function readInstalledVersions(toolsDir) {
  const file = path.join(toolsDir, VERSIONS_FILE);
  if (!await fs.pathExists(file)) return {};
  return (await fs.readJson(file, { throws: false })) || {};
}

function readInstalledVersionsSync(toolsDir) {
  const file = path.join(toolsDir, VERSIONS_FILE);
  if (!fs.pathExistsSync(file)) return {};
  return fs.readJsonSync(file, { throws: false }) || {};
}

async function recordInstalledVersion(toolsDir, fileName, entry) {
  const versions = await readInstalledVersions(toolsDir);
  versions[fileName] = { ...entry, installedAt: new Date().toISOString() };
  await fs.outputJson(path.join(toolsDir, VERSIONS_FILE), versions, { spaces: 2 });
}

/**
 * Makes sure one tool JAR is installed in `toolsDir` in the version from tools.json
 * (or the override from its versionEnv variable).
 *
 * Order: keep a matching install > adopt an unrecorded JAR whose checksum matches >
 * copy a matching JAR from the legacy directory > download.
 *
 * @param {object} tool - Entry from tools.json
 * @param {object} opts
 * @param {string} opts.toolsDir
 * @param {boolean} [opts.force]
 * @param {string|null} [opts.legacyDir]
 * @param {Function} [opts.log]
 * @param {Function} [opts.warn]
 * @returns {Promise<{ version: string, path: string, action: string }>}
 */
async function ensureTool(tool, { toolsDir, force = false, legacyDir = null, log = () => {}, warn = () => {} }) {
  const dest = path.join(toolsDir, tool.fileName);
  const spec = resolveToolSpec(tool);
  const installed = (await readInstalledVersions(toolsDir))[tool.fileName];
  const present = await fs.pathExists(dest);

  if (!spec.pinned) {
    warn(
      `${tool.name}: ${tool.versionEnv}=${spec.override} overrides the pinned version ${tool.version}. ` +
      'The download is NOT checksum-verified.'
    );
  }

  let target = spec;
  if (spec.latest) {
    const latest = await getLatestReleaseAsset(tool.repo, tool.assetPattern);
    target = { ...spec, version: latest.version, url: latest.url };
  }
  if (!target.url) throw new CliError(`No download URL known for ${tool.name} ${target.version}.`);

  if (!force && present) {
    if (installed && installed.version === target.version) {
      log(`${tool.fileName} ${target.version} already installed`);
      return { version: target.version, path: dest, action: 'present' };
    }
    if (!installed && target.sha256 && (await sha256File(dest)) === target.sha256) {
      await recordInstalledVersion(toolsDir, tool.fileName, { version: target.version, sha256: target.sha256, url: target.url });
      log(`${tool.fileName} ${target.version} already installed (checksum verified)`);
      return { version: target.version, path: dest, action: 'adopted' };
    }
  }

  if (!force && !present && legacyDir && target.sha256) {
    const legacyJar = path.join(legacyDir, tool.fileName);
    if (path.resolve(legacyDir) !== path.resolve(toolsDir) && await fs.pathExists(legacyJar) &&
        (await sha256File(legacyJar)) === target.sha256) {
      await fs.ensureDir(toolsDir);
      await fs.copy(legacyJar, dest, { overwrite: true });
      await recordInstalledVersion(toolsDir, tool.fileName, { version: target.version, sha256: target.sha256, url: target.url });
      log(`${tool.fileName} ${target.version} copied from ${legacyDir}`);
      return { version: target.version, path: dest, action: 'copied' };
    }
  }

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    log(`Downloading ${tool.name} ${target.version}${attempt > 1 ? ` (attempt ${attempt}/${MAX_ATTEMPTS})` : ''}...`);
    try {
      await downloadFile(target.url, dest, { sha256: target.sha256 });
      break;
    } catch (err) {
      const retryable = !/Checksum mismatch|HTTP 404|HTTP 403|HTTP 429/.test(err.message);
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw new CliError(`Failed to download ${tool.name} ${target.version}: ${err.message}`, { cause: err });
      }
      warn(`Download of ${tool.name} failed (${err.message}), retrying...`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  await recordInstalledVersion(toolsDir, tool.fileName, { version: target.version, sha256: target.sha256, url: target.url });
  log(`${tool.name} ${target.version} downloaded${target.sha256 ? ' (checksum verified)' : ''}`);
  return { version: target.version, path: dest, action: 'downloaded' };
}

module.exports = {
  VERSIONS_FILE,
  sha256File,
  downloadFile,
  getLatestReleaseAsset,
  resolveToolSpec,
  readInstalledVersions,
  readInstalledVersionsSync,
  ensureTool,
  describeDownloadError,
};
