import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  mdText,
  mdCell,
  mdCode,
  parseSliceDetail,
  buildDetailRows,
  exampleErrorCount,
  generateReport,
} from '../src/lib/reportGen.js';
import { reportInput } from './fixtures/report-input.js';

const ELE1 = 'hasValue() or (children().count() > id.count())';
const NAME_EXPR = 'family.exists() or given.exists()';
const constraintDetail = (expr) => `slice error: The constraint '${expr}' is defined in the claimed profile, but missing`;
const euSdFixture = {
  snapshot: {
    element: [
      { path: 'Patient', constraint: [{ expression: ELE1 }] },
      { path: 'Patient.name', constraint: [{ expression: ELE1 }, { expression: NAME_EXPR }] },
      { path: 'Patient.gender', constraint: [{ expression: ELE1 }] },
    ],
  },
};

test('mdText escapes HTML-significant characters', () => {
  assert.equal(mdText('<script>a & b</script>'), '&lt;script&gt;a &amp; b&lt;/script&gt;');
  assert.equal(mdText(null), '');
  assert.equal(mdText(42), '42');
});

test('mdCell escapes pipes and flattens newlines', () => {
  assert.equal(mdCell('a|b'), 'a\\|b');
  assert.equal(mdCell('x\r\ny\nz'), 'x y z');
  assert.equal(mdCell(mdCode('http://x/eu|1.0.0')), '`http://x/eu\\|1.0.0`');
  assert.equal(mdCell(undefined), '');
});

test('mdCode uses a fence longer than any backtick run', () => {
  assert.equal(mdCode('abc'), '`abc`');
  assert.equal(mdCode('a`b'), '``a`b``');
  assert.equal(mdCode('a``b`'), '``` a``b` ```');
  assert.equal(mdCode('`x'), '`` `x ``');
  assert.equal(mdCode('line1\nline2'), '`line1 line2`');
});

test('parseSliceDetail: min/max, constraint, slicing and fallback', () => {
  assert.deepEqual(
    parseSliceDetail("slice error: The min value of '0' on the path Patient.name does not comply with the value '1' from the claimed profile"),
    ['`Patient.name`', 'min: is `0`, expected `1`'],
  );
  assert.deepEqual(
    parseSliceDetail("The max value of '*' on the path Patient.x does not comply with the value '1' from the claimed profile"),
    ['`Patient.x`', 'max: is `*`, expected `1`'],
  );
  assert.deepEqual(
    parseSliceDetail("slice error: The constraint 'a.exists() or b.exists()' is defined in the claimed profile, but missing"),
    ['—', 'Constraint missing: `a.exists() or b.exists()`'],
  );
  assert.deepEqual(
    parseSliceDetail('Mismatch in slicing at Patient.identifier: none'),
    ['`Patient.identifier`', 'No slicing found, target profile expects slicing'],
  );
  assert.deepEqual(parseSliceDetail('slice error: something <odd>'), ['—', 'something &lt;odd&gt;']);
});

test('exampleErrorCount: a missing result counts as a failure', () => {
  assert.equal(exampleErrorCount(null), 1);
  assert.equal(exampleErrorCount({ summary: null, issues: [] }), 1);
  assert.equal(exampleErrorCount({ summary: { result: 'SUCCESS' }, issues: [], error: 'boom' }), 1);
  assert.equal(exampleErrorCount({ summary: { result: 'SUCCESS' }, issues: [{ severity: 'warning' }] }), 0);
  assert.equal(exampleErrorCount({ summary: { result: 'FAILURE' }, issues: [{ severity: 'error' }, { severity: 'fatal' }, { severity: 'information' }] }), 2);
});

test('generateReport: table cells with "|" stay a single cell', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reportPath = path.join(dir, 'r-report.md');
  const eu1 = 'http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core';
  const eu2 = 'http://hl7.eu/fhir/base/StructureDefinition/patient-eu-ips';

  await generateReport({
    canonical: 'http://example.org/StructureDefinition/My|Patient',
    packageSpec: 'example.pkg@1.0.0',
    euCanonicals: [eu1, eu2],
    euProfiles: [{ url: eu1, version: '0.1.0' }, { url: eu2, version: null }],
    parsed: {
      summary: { result: 'FAILURE', text: '1 errors' },
      issues: [{
        severity: 'error',
        location: 'StructureDefinition',
        message: `The profile does not comply with claimed profile '${eu1}'`,
        msgId: 'SD_EXTENSION_COMPLIES_WITH_ERROR',
        details: [
          "slice error: The constraint 'a.exists() | b.exists()' is defined in the claimed profile, but missing",
          'slice error: weird | detail <b>',
        ],
      }],
    },
    reportPath,
  });

  const md = fs.readFileSync(reportPath, 'utf8');
  assert.match(md, /\*\*1 of 2\*\* checked EU profiles are fulfilled/);
  // versioned canonical: pipe escaped inside the table cell
  assert.ok(md.includes(`| ❌ | \`${eu1}\\|0.1.0\` |`), 'versioned EU canonical row');
  assert.ok(md.includes(`| ✅ | \`${eu2}\` |`));

  // Every table row of the details table must have exactly 3 unescaped pipes (2 columns)
  const rows = md.split('\n').filter(l => l.startsWith('| ') && l.includes('Constraint missing') || l.includes('weird'));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const unescaped = row.replace(/\\\|/g, '').split('|').length - 1;
    assert.equal(unescaped, 3, row);
  }
  assert.ok(md.includes('weird \\| detail &lt;b&gt;'));
});

test('parseSliceDetail: recovers the path of a missing constraint only when it is unambiguous', () => {
  assert.deepEqual(parseSliceDetail(constraintDetail(NAME_EXPR), euSdFixture), ['`Patient.name`', `Constraint missing: \`${NAME_EXPR}\``]);
  // declared on several elements: path stays unknown
  assert.deepEqual(parseSliceDetail(constraintDetail(ELE1), euSdFixture), ['—', `Constraint missing: \`${ELE1}\``]);
  // no EU SD: unchanged behaviour
  assert.deepEqual(parseSliceDetail(constraintDetail(NAME_EXPR)), ['—', `Constraint missing: \`${NAME_EXPR}\``]);
});

test('buildDetailRows: collapses identical rows in first-seen order and shows a count', () => {
  const minDetail = "slice error: The min value of '0' on the path Patient.name does not comply with the value '1' from the claimed profile";
  const rows = buildDetailRows([
    constraintDetail(ELE1),
    minDetail,
    constraintDetail(ELE1),
    constraintDetail(NAME_EXPR),
    constraintDetail(ELE1),
  ]);
  assert.deepEqual(rows, [
    ['—', `Constraint missing: \`${ELE1}\` (reported 3×)`],
    ['`Patient.name`', 'min: is `0`, expected `1`'],
    ['—', `Constraint missing: \`${NAME_EXPR}\``],
  ]);
  assert.deepEqual(buildDetailRows([]), []);
});

test('generateReport: duplicate detail rows are collapsed, constraint paths recovered from the EU SD', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reportPath = path.join(dir, 'r-report.md');
  const eu = 'http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core';

  await generateReport({
    canonical: 'http://example.org/StructureDefinition/MyPatient',
    packageSpec: 'example.pkg@1.0.0',
    euCanonicals: [eu],
    euProfiles: [{ url: eu, version: '2.0.1' }],
    parsed: {
      summary: { result: 'FAILURE', text: '1 errors' },
      issues: [{
        severity: 'error',
        location: 'StructureDefinition',
        message: `The profile does not comply with claimed profile '${eu}'`,
        msgId: 'SD_EXTENSION_COMPLIES_WITH_ERROR',
        details: [constraintDetail(ELE1), constraintDetail(ELE1), constraintDetail(NAME_EXPR)],
      }],
    },
    reportPath,
    euSdByCanonical: new Map([[eu, euSdFixture]]),
  });

  const md = fs.readFileSync(reportPath, 'utf8');
  const rows = md.split('\n').filter(l => l.includes('Constraint missing'));
  assert.deepEqual(rows, [
    `| — | Constraint missing: \`${ELE1}\` (reported 2×) |`,
    `| \`Patient.name\` | Constraint missing: \`${NAME_EXPR}\` |`,
  ]);
});

test('generateReport: Markdown rendered from the report model is identical to the pre-model output', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reportPath = path.join(dir, 'r-report.md');
  await generateReport(reportInput(reportPath));
  const actual = fs.readFileSync(reportPath, 'utf8').replace(/\*\*Date:\*\* \d{4}-\d{2}-\d{2}/, '**Date:** 2026-01-01');
  // Golden file captured from the Markdown renderer before the report model existed (feat/esm-node22 at 0b44fc5)
  // (normalised: a Windows checkout may convert it to CRLF).
  const golden = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'report-golden.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(actual, golden);
});
