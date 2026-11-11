'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const config = require('../src/lib/config');

const FIXTURES = path.join(__dirname, 'fixtures');

test('parseValidatorParams: skips comments/non-flags, splits on first whitespace, drops output flags', () => {
  const raw = fs.readFileSync(path.join(FIXTURES, 'validator-params.md'), 'utf8');
  assert.deepEqual(config.parseValidatorParams(raw), [
    '-version', '4.0.1',
    '-tx', 'n/a',
    '-ig', 'de.basisprofil.r4#1.5.4',
    '-level', 'warnings',
    '-proxy', 'some host:8080',
    '-allow-example-urls', 'true',
    '-debug',
    '-indented-flag', 'value with  spaces',
  ]);
});

test('parseValidatorParams: handles CRLF line endings and empty input', () => {
  assert.deepEqual(config.parseValidatorParams('-a 1\r\n-b\r\n'), ['-a', '1', '-b']);
  assert.deepEqual(config.parseValidatorParams(''), []);
  assert.deepEqual(config.parseValidatorParams('# only a comment'), []);
});

test('parseValidatorParams: the shipped java-validator-parameter.md parses and never contains -output', () => {
  const args = config.loadValidatorParams();
  assert.ok(Array.isArray(args));
  assert.ok(!args.includes('-output'));
  assert.ok(!args.includes('-html-output'));
  for (const a of args) assert.equal(typeof a, 'string');
});

test('resolveHome: env override wins, otherwise ~/.complies-with-eu', () => {
  const home = path.join(os.tmpdir(), 'fake-home');
  assert.equal(config.resolveHome({}, home), path.join(home, '.complies-with-eu'));
  assert.equal(config.resolveHome({ COMPLIES_WITH_EU_HOME: '   ' }, home), path.join(home, '.complies-with-eu'));
  const custom = path.join(os.tmpdir(), 'cwe-home');
  assert.equal(config.resolveHome({ COMPLIES_WITH_EU_HOME: custom }, home), path.resolve(custom));
  assert.equal(config.resolveHome({ COMPLIES_WITH_EU_HOME: 'relative-dir' }, home), path.resolve('relative-dir'));
});

test('resolveWorkdir: override > COMPLIES_WITH_EU_WORKDIR > <home>/workdir', () => {
  const home = path.join(os.tmpdir(), 'cwe-home');
  const envWd = path.join(os.tmpdir(), 'env-wd');
  const cliWd = path.join(os.tmpdir(), 'cli-wd');
  assert.equal(config.resolveWorkdir({ env: {}, home }), path.join(home, 'workdir'));
  assert.equal(config.resolveWorkdir({ env: { COMPLIES_WITH_EU_WORKDIR: envWd }, home }), path.resolve(envWd));
  assert.equal(config.resolveWorkdir({ override: cliWd, env: { COMPLIES_WITH_EU_WORKDIR: envWd }, home }), path.resolve(cliWd));
  // Home derived from env when not passed explicitly
  assert.equal(
    config.resolveWorkdir({ env: { COMPLIES_WITH_EU_HOME: home } }),
    path.join(path.resolve(home), 'workdir'),
  );
});

test('pickToolsDir: complete home dir wins, complete legacy dir is a fallback, otherwise home', () => {
  const homeToolsDir = path.join('h', 'tools');
  const legacyToolsDir = path.join('repo', '.tools');
  const jars = (dir) => [
    path.join(dir, config.VALIDATOR_JAR_NAME),
    path.join(dir, config.FHIR_PKG_TOOL_JAR_NAME),
  ];
  const existsIn = (files) => (p) => files.includes(p);

  assert.deepEqual(
    config.pickToolsDir({ homeToolsDir, legacyToolsDir, exists: existsIn([...jars(homeToolsDir), ...jars(legacyToolsDir)]) }),
    { dir: homeToolsDir, legacy: false },
  );
  assert.deepEqual(
    config.pickToolsDir({ homeToolsDir, legacyToolsDir, exists: existsIn(jars(legacyToolsDir)) }),
    { dir: legacyToolsDir, legacy: true },
  );
  // Incomplete legacy dir (only one jar) is not used
  assert.deepEqual(
    config.pickToolsDir({ homeToolsDir, legacyToolsDir, exists: existsIn([jars(legacyToolsDir)[0]]) }),
    { dir: homeToolsDir, legacy: false },
  );
  // Incomplete home + complete legacy -> legacy
  assert.deepEqual(
    config.pickToolsDir({ homeToolsDir, legacyToolsDir, exists: existsIn([jars(homeToolsDir)[0], ...jars(legacyToolsDir)]) }),
    { dir: legacyToolsDir, legacy: true },
  );
  assert.deepEqual(
    config.pickToolsDir({ homeToolsDir, legacyToolsDir: null, exists: () => false }),
    { dir: homeToolsDir, legacy: false },
  );
});

test('read-only assets: eu-packages.json and tools.json load and are well-formed', () => {
  const eu = config.loadEuPackages();
  assert.ok(eu && typeof eu === 'object');
  const tools = config.loadToolsManifest();
  for (const key of ['validator', 'fhirPkgTool']) {
    const t = tools[key];
    assert.ok(t, `tools.json has ${key}`);
    assert.match(t.sha256, /^[0-9a-f]{64}$/);
    assert.ok(t.url.startsWith('https://github.com/'));
    assert.ok(t.url.includes(t.version), `${key} url contains its version`);
    assert.equal(t.urlTemplate.replace('{version}', t.version), t.url);
    assert.ok(Number.isInteger(t.minJava));
  }
  const info = config.getPackageInfo();
  assert.equal(info.name, '@gefyra/complies-with-eu');
  assert.match(info.version, /^\d+\.\d+\.\d+/);
});
