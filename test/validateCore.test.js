'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePackageSpec, buildErrorReport, summarizeExamples } = require('../src/lib/validateCore');

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
