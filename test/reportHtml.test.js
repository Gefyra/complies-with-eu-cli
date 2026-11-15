import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildReportModel, buildPackageModel } from '../src/lib/reportModel.js';
import {
  esc,
  safeHref,
  logoDataUri,
  issueHint,
  renderHtmlReport,
  renderPackageHtml,
  renderHtmlErrorReport,
} from '../src/lib/reportHtml.js';
import { generateReport, renderPackageMarkdown } from '../src/lib/reportGen.js';
import { writeErrorReport, postProcessProfile } from '../src/lib/validateCore.js';
import { reportInput, EU_CORE, EU_IPS, EU_LAB } from './fixtures/report-input.js';

const EVIL = '"><script>alert(1)</script><img src=x onerror="alert(2)">';
const meta = {
  tool: { name: '@gefyra/complies-with-eu', version: '9.9.9', validatorVersion: '6.7.4' },
  euPackages: [{ packageName: 'hl7.fhir.eu.base', version: '0.1.0' }],
};

/** A raw (unescaped) tag with an event handler attribute. */
const RAW_HANDLER = /<[a-z][^>]*\sonerror=/i;

/** Count of non-overlapping occurrences. */
const count = (s, needle) => s.split(needle).length - 1;

/** Markup without the inline <script> block, which legitimately contains "<script>". */
const withoutInlineScript = html => html.replace(/<script>\n\(function\(\)\{[\s\S]*?<\/script>/, '');

test('esc escapes all HTML-significant characters', () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(7), '7');
});

test('safeHref allows only absolute http(s) URLs', () => {
  assert.equal(safeHref('https://example.org/a?b=1&c=2'), 'https://example.org/a?b=1&amp;c=2');
  assert.equal(safeHref('http://x'), 'http://x');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', '/relative', 'https://a b', 'https://x/\u0000', '', null]) {
    assert.equal(safeHref(bad), null, String(bad));
  }
});

test('the logo is embedded as a data URI from the shipped asset', () => {
  const uri = logoDataUri();
  assert.match(uri, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('assets/gefyra-logo.png'), 'asset is published');
});

test('renderHtmlReport: verdict, tiles and one card per EU profile', () => {
  const html = renderHtmlReport(buildReportModel({ ...reportInput('x'), meta }));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<section class="verdict fail"/);
  assert.match(html, /Not compliant/);
  assert.match(html, /1 of 3 checked EU profiles fulfilled, 2 not fulfilled\./);
  assert.equal(count(html, '<article class="card '), 3);
  assert.equal(count(html, '<span class="badge fail">FAIL</span>'), 2);
  assert.equal(count(html, '<span class="badge pass">PASS</span>'), 1);
  for (const eu of [`${EU_CORE}|2.0.1`, EU_IPS, `${EU_LAB}|0.1.0`]) {
    assert.ok(html.includes(`<code>${esc(eu)}</code>`), eu);
  }
  // tiles: checked / fulfilled / not fulfilled / obligation violations
  assert.match(html, /<span class="num">3<\/span><span class="label">EU profiles checked/);
  assert.match(html, /<span class="num">1<\/span><span class="label">fulfilled/);
  assert.match(html, /<span class="num">2<\/span><span class="label">not fulfilled/);
  assert.match(html, /<span class="num">3<\/span><span class="label">obligation violations/);
  // collapsed duplicate row, counts, auto-resolved info, obligations, metadata
  assert.ok(html.includes('<td class="num">2×</td>'));
  assert.match(html, /Automatically resolved \(information\)/);
  assert.match(html, /Element not found in profile/);
  assert.match(html, /HL7 FHIR Validator 6\.7\.4/);
  assert.match(html, /hl7\.fhir\.eu\.base#0\.1\.0/);
  // other validation results: collapsed by default, grouped with counts
  assert.match(html, /<details class="other"><summary>4 messages: 1 fatal, 1 error, 1 warning, 1 information<\/summary>/);
  assert.match(html, /How to read this report/);
  // self-contained: no external resources
  assert.doesNotMatch(html, /<link\b|<script\s+src|@import|url\(http/i);
});

test('renderHtmlReport: untrusted values are escaped everywhere', () => {
  const input = reportInput('x');
  input.canonical = `http://evil.example/StructureDefinition/${EVIL}`;
  input.packageSpec = EVIL;
  input.parsed.issues.push({ severity: 'warning', location: EVIL, message: EVIL, msgId: EVIL });
  input.parsed.issues[0].details.push(`slice error: The constraint '${EVIL}' is defined in the claimed profile, but missing`);
  input.autoSatisfiedConstraints[0].matchedChild = EVIL;
  const html = withoutInlineScript(renderHtmlReport(buildReportModel({
    ...input,
    meta: { tool: { name: EVIL, version: EVIL, validatorVersion: EVIL }, euPackages: [{ packageName: EVIL, version: EVIL }] },
  })));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img src=x/i);
  assert.doesNotMatch(html, RAW_HANDLER);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  // the fixture's own "<img ... onerror>" detail is escaped too
  assert.ok(html.includes('weird | detail &lt;img src=x onerror=alert(1)&gt;'));
});

test('renderHtmlReport: the inline script never writes markup', () => {
  const html = renderHtmlReport(buildReportModel(reportInput('x')));
  const scripts = html.match(/<script>[\s\S]*?<\/script>/g);
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(scripts[0], /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  // works without JS: the toolbar is hidden until the script shows it
  assert.match(html, /<div class="toolbar" id="toolbar" hidden>/);
});

test('renderHtmlReport: all-pass and no-EU-profile verdicts', () => {
  const pass = renderHtmlReport(buildReportModel({
    canonical: 'http://x/P', packageSpec: 'p@1', euCanonicals: [EU_IPS], parsed: { summary: { text: 'ok' }, issues: [] },
  }));
  assert.match(pass, /<section class="verdict pass"/);
  assert.match(pass, /Compliant with all checked EU profiles/);
  assert.doesNotMatch(pass, /Other validation results<\/h2>/);
  const none = renderHtmlReport(buildReportModel({
    canonical: 'http://x/P', packageSpec: 'p@1', euCanonicals: [], parsed: { summary: { text: 'ok' }, issues: [] },
  }));
  assert.match(none, /<section class="verdict none"/);
});

test('issueHint explains constraints depending on whether auto-resolution applies', () => {
  const notExists = issueHint({ kind: 'constraint', expression: 'value.empty() or x.empty()', autoResolvable: false }, null);
  assert.match(notExists, /different form, so it was not evaluated/);
  const hint = autoCheck => issueHint({ kind: 'constraint', expression: 'a.exists() or b.exists()', autoResolvable: true, autoCheck }, 'Patient');
  assert.match(hint('unsatisfied'), /It was evaluated against your profile: none of the alternatives is required there/);
  assert.match(hint('noEuSd'), /not evaluated: the claimed EU profile was not found in the loaded EU packages/);
  assert.match(hint('noBasePath'), /not evaluated: no element of the EU profile declares this rule/);
  // Without an evaluation result, the hint must not claim that cardinalities were compared
  for (const unknown of ['notEvaluated', null, undefined]) {
    assert.match(hint(unknown), /no evaluation result is available/);
    assert.doesNotMatch(hint(unknown), /evaluated against|do not guarantee/);
  }
  assert.match(issueHint({ kind: 'slicing' }, 'Patient.identifier'), /slices this element/);
  assert.equal(issueHint({ kind: 'other', text: 'x' }, null), null);
});

test('buildReportModel records the outcome of the automatic resolution per constraint', () => {
  const NAME_EXPR = 'family.exists() or given.exists()';
  const ELE1 = 'hasValue() or (children().count() > id.count())';
  const constraintsOf = m => m.euProfiles[0].details.filter(d => d.issue.kind === 'constraint').map(d => d.issue);

  const evaluated = buildReportModel({
    ...reportInput('x'),
    constraintChecks: [{ euCanonical: EU_CORE, expression: NAME_EXPR, reason: 'unsatisfied' }],
  });
  assert.deepEqual(constraintsOf(evaluated).map(i => [i.expression, i.autoCheck]), [[ELE1, null], [NAME_EXPR, 'unsatisfied']]);
  assert.match(renderHtmlReport(evaluated), /It was evaluated against your profile/);

  // No recorded outcome (e.g. the resolution threw): neutral wording, no claim about cardinalities
  const unknown = buildReportModel(reportInput('x'));
  assert.equal(constraintsOf(unknown)[1].autoCheck, 'notEvaluated');
  const html = renderHtmlReport(unknown);
  assert.match(html, /no evaluation result is available/);
  assert.doesNotMatch(html, /do not guarantee it|evaluated against your profile/);
});

test('renderHtmlReport: PASS reached only through auto-resolved constraints is not called "accepted"', () => {
  const issues = [{
    severity: 'error', location: 'StructureDefinition', msgId: 'SD_EXTENSION_COMPLIES_WITH_ERROR',
    message: `The profile does not comply with claimed profile '${EU_IPS}'`,
    details: ["slice error: The constraint 'a.exists() or b.exists()' is defined in the claimed profile, but missing"],
  }];
  const html = renderHtmlReport(buildReportModel({
    canonical: 'http://x/P', packageSpec: 'p@1', euCanonicals: [EU_IPS], parsed: { summary: { text: '1 error' }, issues },
    filteredNonCompliantMap: new Map(),
    autoSatisfiedConstraints: [{ euCanonical: EU_IPS, expression: 'a.exists() or b.exists()', basePath: 'Patient', matchedChild: 'Patient.a (min: 1)' }],
  }));
  assert.match(html, /<span class="badge pass">PASS<\/span>/);
  assert.match(html, /The validator reported only constraints that this tool resolved automatically/);
  assert.doesNotMatch(html, /the validator accepted the claim and the obligation check/);
  assert.match(html, /or all of its findings were resolved automatically/);
});

test('renderHtmlReport: obligation failures use the failure style; layout hooks for small screens', () => {
  const html = renderHtmlReport(buildReportModel(reportInput('x')));
  // Patient-eu-lab fails only on obligations: shown like other failures, not as a warning
  assert.match(html, /<div class="panel fail"><h4>Obligation check/);
  assert.doesNotMatch(html, /<div class="panel warn">/);
  assert.match(html, /<div class="tile fail"><span class="num">3<\/span><span class="label">obligation violations/);
  // element paths keep a readable column width
  assert.match(html, /<td class="path"><code>Patient\.name<\/code><\/td>/);
  assert.match(html, /td\.path code\{overflow-wrap:normal;word-break:normal\}/);
  // two tiles per row on phones; how-to closed in markup, opened by the script on wide screens
  assert.ok(html.includes('  .tiles{grid-template-columns:repeat(2,1fr)}'));
  assert.match(html, /<details class="howto" id="howto"><summary>/);
  assert.match(html, /matchMedia\('\(min-width:641px\)'\)\.matches\)how\.open=true/);
});

test('generateReport returns the model; HTML and Markdown come from the same model', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-html-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const model = await generateReport(reportInput(path.join(dir, 'r-report.md')));
  assert.equal(model.kind, 'profile');
  assert.equal(model.summary.nonCompliant, 2);
  assert.deepEqual(model.euProfiles.map(p => p.pass), [false, true, false]);
  assert.equal(model.euProfiles[0].details.find(d => d.issue.kind === 'constraint' && d.path === null).count, 2);
});

test('package report: Markdown unchanged, HTML with relative links and escaped values', () => {
  const profiles = [
    { canonical: 'http://x/StructureDefinition/A', slug: 'x_A', pass: true, compliance: [{ euCanonical: `${EU_IPS}|1.0.0`, pass: true }] },
    { canonical: 'http://x/StructureDefinition/B|<b>', slug: 'x_B', pass: false, compliance: [{ euCanonical: EU_CORE, pass: false }] },
    { canonical: 'http://x/StructureDefinition/C', slug: 'x_C', pass: false, error: EVIL },
  ];
  const model = buildPackageModel({ packageSpec: 'pkg@1.0.0', profiles, total: 3, date: new Date('2026-01-01T00:00:00Z') });
  assert.equal(renderPackageMarkdown(model), [
    '# Package Compliance Report: pkg@1.0.0',
    '',
    '**Date:** 2026-01-01',
    '**Profiles:** 3 total, 1 compliant, 1 non-compliant, 1 with errors',
    '',
    '## Profiles',
    '',
    '| Profile | Status | Report |',
    '|---------|--------|--------|',
    '| A | ✅ | [Report](x_A-report.md) |',
    '| B\\|&lt;b&gt; | ❌ | [Report](x_B-report.md) |',
    '| C | ⚠️ error | [Report](x_C-report.md) |',
    '',
  ].join('\n'));

  const html = withoutInlineScript(renderPackageHtml(model));
  assert.ok(html.includes('<a href="x_A-report.html">HTML</a>'));
  // the profile name links to its report too, so the first column always leads there
  assert.ok(html.includes('<strong><a href="x_A-report.html">A</a></strong>'));
  // stacked rows on phones keep the report links visible
  assert.match(html, /<table class="pkg">/);
  assert.match(html, /table\.pkg td\.eu,table\.pkg td\.links\{grid-column:1 \/ -1\}/);
  assert.ok(html.includes('<a href="x_B-report.md">Markdown</a>'));
  assert.equal(count(html, '<span class="badge pass">PASS</span>'), 1);
  assert.equal(count(html, '<span class="badge fail">FAIL</span>'), 1);
  assert.equal(count(html, '<span class="badge error">ERROR</span>'), 1);
  assert.ok(html.includes('B|&lt;b&gt;'));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, RAW_HANDLER);
});

test('error report: HTML written next to the Markdown only with html: true', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-err-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const md = await writeErrorReport('s1', 'http://x/P', 'p@1', 'boom', dir);
  assert.equal(fs.existsSync(md.replace(/\.md$/, '.html')), false);
  const md2 = await writeErrorReport('s2', 'http://x/P', 'p@1', EVIL, dir, { html: true, meta });
  const html = withoutInlineScript(fs.readFileSync(md2.replace(/\.md$/, '.html'), 'utf8'));
  assert.match(html, /Processing error/);
  // amber like the ERROR badge on the package page, not the red non-compliance banner
  assert.match(html, /<section class="verdict error" aria-label="Verdict"><span class="verdict-icon" aria-hidden="true">!<\/span>/);
  assert.doesNotMatch(html, /verdict fail/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, RAW_HANDLER);
  assert.equal(withoutInlineScript(renderHtmlErrorReport({ canonical: 'http://x/P', packageSpec: 'p', message: 'm', date: 'd' })).includes('<script'), false);
});

test('postProcessProfile writes <slug>-report.html only with options.html', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-pp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = reportInput('unused');
  const common = {
    pkgDir: path.join(dir, 'no-such-package'),
    profile: { url: input.canonical, type: 'Patient', snapshot: { element: [] } },
    canonical: input.canonical,
    packageSpec: input.packageSpec,
    euPackageDirs: [],
    euProfiles: input.euProfiles,
    euCanonicals: input.euCanonicals,
    parsed: input.parsed,
    reportDir: dir,
  };
  const without = await postProcessProfile({ ...common, slug: 'plain' });
  assert.equal(without.htmlReportPath, null);
  assert.equal(fs.existsSync(path.join(dir, 'plain-report.html')), false);

  const withHtml = await postProcessProfile({ ...common, slug: 'rich', options: { html: true } });
  assert.equal(withHtml.htmlReportPath, path.join(dir, 'rich-report.html'));
  assert.match(fs.readFileSync(withHtml.htmlReportPath, 'utf8'), /<section class="verdict fail"/);
  assert.deepEqual(withHtml.compliance, without.compliance);
  // no EU package dirs: the EU SD was not found, so the constraint was not evaluated, and the HTML says so
  assert.match(fs.readFileSync(withHtml.htmlReportPath, 'utf8'), /not evaluated: the claimed EU profile was not found in the loaded EU packages/);
});
