import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parsePackageSpec, buildErrorReport, summarizeExamples, runExamplesForProfile } from '../src/lib/validateCore.js';
import { createValidatorError } from '../src/lib/validatorOutput.js';
import { generateExampleReport } from '../src/lib/reportGen.js';

test('runExamplesForProfile: a validator crash gives every example a one-line error', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-ex-'));
  try {
    const pkgDir = path.join(tmp, 'pkg');
    fs.mkdirSync(path.join(pkgDir, 'package', 'example'), { recursive: true });
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(pkgDir, 'package', 'example', `Patient-${i}.json`), JSON.stringify({ resourceType: 'Patient', id: `p${i}` }));
    }
    const examplesDir = path.join(tmp, 'examples', 'pat');
    const logPath = path.join(examplesDir, '_batch-raw.log');
    const crashOutput = Array.from({ length: 30 }, (_, i) => `\tat org.hl7.Foo.bar${i}(Foo.java:${i})`).join('\n');
    const logged = [];

    const exResult = await runExamplesForProfile({
      pkgDir,
      fhirType: 'Patient',
      slug: 'pat',
      examplesDir,
      euCanonicals: ['http://x/eu'],
      igIds: [],
      log: (m) => logged.push(m),
      runBatch: async () => {
        throw createValidatorError({ reason: 'produced no result summary', code: 1, rawOutput: crashOutput, logPath });
      },
    });

    // The full message (with the output tail) is logged once
    const crashLogs = logged.filter(m => m.includes('Example validation failed'));
    assert.equal(crashLogs.length, 1);
    assert.match(crashLogs[0], /Last 20 line\(s\) of validator output/);

    const expected = `FHIR Java Validator produced no result summary (exit code 1). Full validator output: ${logPath}`;
    const summary = summarizeExamples(exResult);
    assert.equal(summary.total, 3);
    for (const r of summary.results) {
      assert.equal(r.pass, false);
      assert.equal(r.error, expected, '--json error is one line');
    }

    await generateExampleReport({
      canonical: 'http://x/StructureDefinition/pat',
      packageSpec: 'x@1.0.0',
      euCanonicals: ['http://x/eu'],
      results: exResult.exampleResults,
      reportPath: exResult.exReportPath,
    });
    const report = fs.readFileSync(exResult.exReportPath, 'utf8');
    const errorLines = report.split('\n').filter(l => l.startsWith('**ERROR:**'));
    assert.equal(errorLines.length, 3);
    assert.ok(errorLines.every(l => l.includes('exit code 1') && l.endsWith('It is counted as failed.')), errorLines.join('\n'));
    assert.ok(!report.includes('Foo.java'), 'no output tail in the report');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('parsePackageSpec: name, name@version, name#version, default "current"', () => {
  assert.deepEqual(parsePackageSpec('hl7.fhir.uv.ips'), { packageName: 'hl7.fhir.uv.ips', version: 'current' });
  assert.deepEqual(parsePackageSpec('hl7.fhir.uv.ips@2.0.0'), { packageName: 'hl7.fhir.uv.ips', version: '2.0.0' });
  assert.deepEqual(parsePackageSpec('hl7.fhir.uv.ips#2.0.0'), { packageName: 'hl7.fhir.uv.ips', version: '2.0.0' });
  assert.deepEqual(parsePackageSpec('kbv.basis@'), { packageName: 'kbv.basis', version: 'current' });
  assert.deepEqual(parsePackageSpec('hl7.eu.fhir.base@0.1.0-ballot'), { packageName: 'hl7.eu.fhir.base', version: '0.1.0-ballot' });
});

test('parsePackageSpec: a leading "@" is not a version separator', () => {
  assert.deepEqual(parsePackageSpec('@scope/pkg'), { packageName: '@scope/pkg', version: 'current' });
  assert.deepEqual(parsePackageSpec('@scope/pkg@1.2.3'), { packageName: '@scope/pkg', version: '1.2.3' });
});

test('buildErrorReport: English, escaped, dated', () => {
  const md = buildErrorReport(
    'http://example.org/StructureDefinition/<Bad>',
    'pkg@1.0.0',
    'line one <x>\nline two',
    new Date('2026-01-02T03:04:05Z'),
  );
  assert.match(md, /^# Compliance Report: &lt;Bad&gt; — ❌ ERROR/);
  assert.ok(md.includes('**Package:** `pkg@1.0.0` | **Date:** 2026-01-02'));
  assert.ok(md.includes('> ⚠️ line one &lt;x&gt;\n> line two'));
  assert.ok(md.includes('This profile could not be validated.'));
});

test('summarizeExamples: missing results are failures, JSON shape is stable', () => {
  assert.deepEqual(summarizeExamples(null), { reportPath: null, total: 0, passed: 0, results: [] });
  const out = summarizeExamples({
    exReportPath: '/w/ex-report.md',
    exampleResults: [
      { fileName: 'a.json', parsed: { summary: { text: '0 errors' }, issues: [{ severity: 'warning' }] } },
      { fileName: 'b.json', parsed: { summary: { text: '1 errors' }, issues: [{ severity: 'error' }] } },
      { fileName: 'c.json', parsed: null },
      { fileName: 'd.json', parsed: { summary: null, issues: [], error: 'timeout' } },
    ],
  });
  assert.equal(out.reportPath, '/w/ex-report.md');
  assert.equal(out.total, 4);
  assert.equal(out.passed, 1);
  assert.deepEqual(out.results[0], { fileName: 'a.json', pass: true, errors: 0, warnings: 1, summary: '0 errors' });
  assert.equal(out.results[1].pass, false);
  assert.deepEqual(out.results[2], { fileName: 'c.json', pass: false, errors: 1, warnings: 0, summary: null });
  assert.deepEqual(out.results[3], { fileName: 'd.json', pass: false, errors: 1, warnings: 0, summary: null, error: 'timeout' });
});
