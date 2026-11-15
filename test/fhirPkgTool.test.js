import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeFhirPkgToolOutput, describeFhirPkgToolFailure } from '../src/lib/fhirPkgTool.js';
import { checkPackageArgument } from '../src/lib/validateCore.js';

// Real fhir-pkg-tool 0.5.0 output for an unknown package id.
const NOT_FOUND_OUTPUT = [
  'FHIR Package Tool starting...',
  'FHIR Package Tool Configuration:',
  '  Configured output directory: /home/fhir/.fhir/packages',
  '  Running in local environment',
  '',
  'Detected cache metadata version in packages.ini: 4',
  'Requested packages:',
  '  - ISiKPatient@current',
  'Failed to install requested package ISiKPatient@current (Unable to resolve package id ISiKPatient#current). Continuing.',
  'No packages loaded – aborting.',
].join('\n');

const STACKTRACE_OUTPUT = [
  'FHIR Package Tool starting...',
  'Exception in thread "main" java.net.UnknownHostException: packages.fhir.org',
  '\tat java.base/sun.nio.ch.NioSocketImpl.connect(NioSocketImpl.java:567)',
  '\tat java.base/java.net.Socket.connect(Socket.java:751)',
  '\tat de.gefyra.fhirpkg.Main.main(Main.java:42)',
].join('\n');

const SUCCESS_OUTPUT = [
  'Installed package hl7.fhir.eu.base#2.0.1 at /home/fhir/.fhir/packages/hl7.fhir.eu.base#2.0.1',
  'Installed package hl7.fhir.r4.core#4.0.1 at /home/fhir/.fhir/packages/hl7.fhir.r4.core#4.0.1',
  'Done: 4102 SDs found',
].join('\n');

test('summarizeFhirPkgToolOutput: unknown package', () => {
  const s = summarizeFhirPkgToolOutput(NOT_FOUND_OUTPUT);
  assert.deepEqual(s.failures, [{ spec: 'ISiKPatient@current', reason: 'Unable to resolve package id ISiKPatient#current' }]);
  assert.equal(s.notFound, true);
  assert.equal(s.network, false);
});

test('summarizeFhirPkgToolOutput: Java stack trace is reduced to the exception line', () => {
  const s = summarizeFhirPkgToolOutput(STACKTRACE_OUTPUT);
  assert.equal(s.exception, 'java.net.UnknownHostException: packages.fhir.org');
  assert.equal(s.network, true);
});

test('summarizeFhirPkgToolOutput: installed packages', () => {
  assert.deepEqual(summarizeFhirPkgToolOutput(SUCCESS_OUTPUT).installed, ['hl7.fhir.eu.base#2.0.1', 'hl7.fhir.r4.core#4.0.1']);
});

test('describeFhirPkgToolFailure: short message without stack frames, with log path', () => {
  const msg = describeFhirPkgToolFailure({
    code: 3, specs: ['ISiKPatient@current'], summary: summarizeFhirPkgToolOutput(NOT_FOUND_OUTPUT), logFile: '/tmp/fhir-pkg-tool.log',
  });
  assert.match(msg, /^Package 'ISiKPatient@current' was not found in the FHIR package registry\./);
  assert.match(msg, /Reason: ISiKPatient@current: Unable to resolve package id ISiKPatient#current/);
  assert.match(msg, /Full fhir-pkg-tool output: \/tmp\/fhir-pkg-tool\.log/);
  assert.ok(msg.split('\n').length <= 5);

  const net = describeFhirPkgToolFailure({ code: 1, specs: ['a.b@1.0.0'], summary: summarizeFhirPkgToolOutput(STACKTRACE_OUTPUT), logFile: null });
  assert.match(net, /could not be reached/);
  assert.doesNotMatch(net, /\bat java\./);
});

test('checkPackageArgument: accepts package ids, rejects bare profile names', () => {
  for (const ok of ['de.gematik.isik', 'de.gematik.isik@5.1.1', 'hl7.fhir.uv.ips#2.0.0', 'de.gematik.epa.laboratory@1.0.0-ballot.1', 'KBV.Basis@1.7.0']) {
    assert.equal(checkPackageArgument(ok), null, ok);
  }
  const msg = checkPackageArgument('ISiKPatient', { allowCanonical: true });
  assert.match(msg, /'ISiKPatient' is not a FHIR package id or a canonical URL\./);
  assert.match(msg, /https:\/\/gematik\.de\/fhir\/isik\/StructureDefinition\/ISiKPatient/);
  assert.match(msg, /simplifier\.net\/search/);
  assert.match(checkPackageArgument('ISiKPatient'), /^'ISiKPatient' is not a FHIR package id\.\n/);
});
