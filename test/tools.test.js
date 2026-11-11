'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveToolSpec, describeDownloadError } = require('../src/lib/toolDownloader');
const { compareVersions } = require('../src/lib/fhirPkgTool');
const { isKeptFile } = require('../src/commands/clean');
const tools = require('../tools.json');

test('resolveToolSpec: pinned by default and when the override equals the pin', () => {
  const v = tools.validator;
  const pinned = { version: v.version, url: v.url, sha256: v.sha256, pinned: true, latest: false, override: null };
  assert.deepEqual(resolveToolSpec(v, {}), pinned);
  assert.deepEqual(resolveToolSpec(v, { [v.versionEnv]: v.version }), pinned);
  assert.deepEqual(resolveToolSpec(v, { [v.versionEnv]: '' }), pinned);
});

test('resolveToolSpec: "latest" and explicit tags are unpinned and unverified', () => {
  const v = tools.validator;
  assert.deepEqual(resolveToolSpec(v, { [v.versionEnv]: 'LATEST' }), {
    version: null, url: null, sha256: null, pinned: false, latest: true, override: 'LATEST',
  });
  const tagged = resolveToolSpec(v, { [v.versionEnv]: ' 6.10.4 ' });
  assert.equal(tagged.version, '6.10.4');
  assert.equal(tagged.url, 'https://github.com/hapifhir/org.hl7.fhir.core/releases/download/6.10.4/validator_cli.jar');
  assert.equal(tagged.sha256, null);
  assert.equal(tagged.pinned, false);
  // Tag is URL-encoded
  assert.ok(resolveToolSpec(v, { [v.versionEnv]: 'a/b' }).url.includes('a%2Fb'));
});

test('describeDownloadError: actionable messages', () => {
  const url = 'https://github.com/x/y/releases/download/v1/x.jar';
  assert.match(describeDownloadError({ response: { status: 403 } }, url), /GITHUB_TOKEN/);
  assert.match(describeDownloadError({ response: { status: 429 } }, url), /rate limited/);
  assert.match(describeDownloadError({ response: { status: 404 } }, url), /Not found \(HTTP 404\)/);
  assert.match(describeDownloadError({ response: { status: 500 } }, url), /HTTP 500/);
  assert.match(describeDownloadError({ code: 'ENOTFOUND', message: 'x' }, url), /Network error \(ENOTFOUND\)/);
  assert.match(describeDownloadError({ message: 'weird' }, url), /^weird \(/);
});

test('compareVersions: semver-ish ordering, releases above pre-releases', () => {
  const sorted = ['1.0.0', '0.9.0', '1.10.0', '1.2.0', '1.0.0-ballot', '2.0.0-rc1', '1.0'].sort(compareVersions);
  assert.deepEqual(sorted, ['0.9.0', '1.0.0-ballot', '1.0.0', '1.0', '1.2.0', '1.10.0', '2.0.0-rc1']);
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-ballot') > 0);
  assert.ok(compareVersions('1.0.0-a', '1.0.0-b') < 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  // Non-numeric versions sort after (above) numeric ones
  assert.ok(compareVersions('1.0.0', 'dev') < 0);
  assert.ok(compareVersions('dev', '1.0.0') > 0);
});

test('clean.isKeptFile keeps reports and mapping.json only', () => {
  assert.equal(isKeptFile('/w/pkg/Patient-report.md'), true);
  assert.equal(isKeptFile('/w/pkg/mapping.json'), true);
  assert.equal(isKeptFile('/w/pkg/Patient-modified.json'), false);
  assert.equal(isKeptFile('/w/pkg/_batch-raw.log'), false);
  assert.equal(isKeptFile('/w/pkg/notes.md'), false);
});
