import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeFhirPkgToolOutput, describeFhirPkgToolFailure, findSnapshotFailure, describeSnapshotFailures,
} from '../src/lib/fhirPkgTool.js';
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

// Real fhir-pkg-tool 0.5.0 output (shortened) for a package with logical models
// whose snapshot cannot be generated, run with --ignore-snapshot-errors.
const LM_REASON = 'StructureDefinition http://medmij.nl/fhir/StructureDefinition/medmij-core-lm-Base at medmij-core-lm-Base.Effective[x]: invalid constrained type Period from dateTime in http://hl7.org/fhir/StructureDefinition/Element';
const SNAPSHOT_FAILURE_OUTPUT = [
  'Installed package medmij.fhir.nl.r4.pathology#1.0.0-alpha.3 at /home/fhir/.fhir/packages/medmij.fhir.nl.r4.pathology#1.0.0-alpha.3',
  'Installed package medmij.fhir.nl.r4.core#1.2.0 at /home/fhir/.fhir/packages/medmij.fhir.nl.r4.core#1.2.0',
  `[main] ERROR org.hl7.fhir.r5.conformance.profile.ProfileUtilities - Exception generating snapshot for http://medmij.nl/fhir/StructureDefinition/medmij-core-lm-Base|1.2.0: ${LM_REASON}`,
  `Snapshot generation failed for medmij.fhir.nl.r4.pathology#1.0.0-alpha.3/StructureDefinition-path-lm-Report.json (${LM_REASON}). Keeping the resource unchanged.`,
  `Snapshot generation failed for medmij.fhir.nl.r4.core#1.2.0/StructureDefinition-medmij-core-lm-Base.json (${LM_REASON}). Keeping the resource unchanged.`,
  'Done: 1031 SDs found, 17 snapshots generated, 2 failed, 17 SD files written, 463 files copied. Local: 0 SDs, 0 generated, 0 failed, 0 written.',
  'Warning: 2 snapshot(s) could not be generated; ignored due to --ignore-snapshot-errors.',
].join('\n');

test('summarizeFhirPkgToolOutput: snapshot failures are collected, not treated as an exception', () => {
  const s = summarizeFhirPkgToolOutput(SNAPSHOT_FAILURE_OUTPUT);
  assert.deepEqual(s.snapshotFailures, [
    { file: 'medmij.fhir.nl.r4.pathology#1.0.0-alpha.3/StructureDefinition-path-lm-Report.json', reason: LM_REASON },
    { file: 'medmij.fhir.nl.r4.core#1.2.0/StructureDefinition-medmij-core-lm-Base.json', reason: LM_REASON },
  ]);
  assert.equal(s.installed.length, 2);
  assert.equal(s.exception, null);
  assert.equal(s.unknownOption, false);
  assert.deepEqual(summarizeFhirPkgToolOutput(SUCCESS_OUTPUT).snapshotFailures, []);
});

test('summarizeFhirPkgToolOutput: detects a fhir-pkg-tool that does not know --ignore-snapshot-errors', () => {
  const s = summarizeFhirPkgToolOutput("FHIR Package Tool starting...\n\x1b[31m\x1b[1mUnknown option: '--ignore-snapshot-errors'\x1b[21m\x1b[39m\x1b[0m\nUsage: fhir-pkg-tool");
  assert.equal(s.unknownOption, true);
});

test('findSnapshotFailure: matches by package and file name', () => {
  const { snapshotFailures } = summarizeFhirPkgToolOutput(SNAPSHOT_FAILURE_OUTPUT);
  const dir = '/home/fhir/.fhir/packages/medmij.fhir.nl.r4.pathology#1.0.0-alpha.3/package';
  assert.equal(findSnapshotFailure(snapshotFailures, `${dir}/StructureDefinition-path-lm-Report.json`).reason, LM_REASON);
  assert.equal(findSnapshotFailure(snapshotFailures, 'C:\\Users\\x\\.fhir\\packages\\medmij.fhir.nl.r4.core#1.2.0\\package\\StructureDefinition-medmij-core-lm-Base.json').file,
    'medmij.fhir.nl.r4.core#1.2.0/StructureDefinition-medmij-core-lm-Base.json');
  assert.equal(findSnapshotFailure(snapshotFailures, `${dir}/StructureDefinition-path-Patient.json`), null);
  assert.equal(findSnapshotFailure(undefined, `${dir}/StructureDefinition-path-lm-Report.json`), null);
});

test('describeSnapshotFailures: names the StructureDefinitions and caps the list', () => {
  const { snapshotFailures } = summarizeFhirPkgToolOutput(SNAPSHOT_FAILURE_OUTPUT);
  const msg = describeSnapshotFailures(snapshotFailures);
  assert.match(msg, /^No snapshot could be generated for 2 StructureDefinitions \(path-lm-Report, medmij-core-lm-Base\)\./);
  const many = Array.from({ length: 8 }, (_, i) => ({ file: `p#1/StructureDefinition-x${i}.json`, reason: '' }));
  assert.match(describeSnapshotFailures(many), /\(x0, x1, x2, x3, x4, and 3 more\)/);
  assert.match(describeSnapshotFailures(many.slice(0, 1)), /for 1 StructureDefinition \(x0\)/);
});
