import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildReportModel, buildPackageModel, buildExamplesModel } from '../src/lib/reportModel.js';
import {
  esc,
  safeHref,
  logoDataUri,
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
  assert.match(html, /Automatically resolved constraints/);
  assert.match(html, /Element not found in profile/);
  assert.match(html, /HL7 FHIR Validator 6\.7\.4/);
  assert.match(html, /hl7\.fhir\.eu\.base#0\.1\.0/);
  // other validation results: collapsed by default, grouped with counts
  assert.match(html, /<details class="other"><summary>4 messages: 1 fatal, 1 error, 1 warning, 1 information<\/summary>/);
  // minimal texts: no explanation boxes
  assert.doesNotMatch(html, /How to read this report|What does this mean\?|class="howto"|class="hint"/);
  // without --examples there is no examples section
  assert.doesNotMatch(html, /id="examples"/);
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
  input.autoSatisfiedConstraints[1].basePath = EVIL;
  input.autoSatisfiedConstraints[1].type = EVIL;
  input.autoSatisfiedConstraints[1].matchedChild = EVIL;
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

test('renderHtmlReport: PASS reached only through auto-resolved constraints says "No remaining findings"', () => {
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
  assert.match(html, /<p class="ok">No remaining findings\.<\/p>/);
  assert.doesNotMatch(html, /accepted the claim/);
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
  // two tiles per row on phones
  assert.ok(html.includes('  .tiles{grid-template-columns:repeat(2,1fr)}'));
  // no leftovers of the removed explanation boxes
  assert.doesNotMatch(html, /howto|details\.hint|matchMedia/);
});

test('renderHtmlReport: optional EU type slices are information on their EU profile card, never failures', () => {
  const model = buildReportModel(reportInput('x'));
  assert.equal(model.typeSlices.length, 1);
  assert.equal(model.autoResolved.length, 1, 'type slices are not listed as resolved constraints');
  const core = model.euProfiles.find(p => p.canonical === EU_CORE);
  assert.equal(core.typeSlices[0].type, 'boolean');
  assert.deepEqual(model.euProfiles.filter(p => p.canonical !== EU_CORE).map(p => p.typeSlices.length), [0, 0]);

  const html = renderHtmlReport(model);
  const coreCard = html.slice(html.indexOf(`<code>${esc(`${EU_CORE}|2.0.1`)}</code>`));
  const panel = coreCard.slice(coreCard.indexOf('<h4>Not applicable in this profile</h4>'));
  assert.ok(coreCard.indexOf('<h4>Not applicable in this profile</h4>') > 0);
  assert.match(html, /<div class="panel info"><h4>Not applicable in this profile<\/h4>/);
  assert.match(panel, /<li><code>Patient\.deceased\[x\]:deceasedBoolean<\/code> <code>boolean<\/code><span class="sub">type boolean is not allowed here \(allowed: dateTime \| &lt;x&gt;\); the EU slice is optional \(0\.\.1\)<\/span><\/li>/);
  // not in the failure table of the card
  assert.doesNotMatch(html, /<td[^>]*>[^<]*deceasedBoolean/);
  assert.equal(count(html, 'Not applicable in this profile'), 1);

  // a profile whose only validator findings are type slices passes
  const pass = renderHtmlReport(buildReportModel({
    canonical: 'http://x/P', packageSpec: 'p@1', euCanonicals: [EU_IPS], parsed: { summary: { text: '1 error' }, issues: [] },
    filteredNonCompliantMap: new Map(),
    autoSatisfiedConstraints: [{ kind: 'type-slice', euCanonical: EU_IPS, basePath: 'Observation.value[x]:valueBoolean', sliceName: 'valueBoolean', type: 'boolean', expression: 'e', matchedChild: 'm' }],
  }));
  assert.match(pass, /<section class="verdict pass"/);
  assert.match(pass, /<p class="ok">No remaining findings\.<\/p>/);
  assert.doesNotMatch(pass, /Automatically resolved constraints/);
});

const EXAMPLE_RESULTS = [
  { fileName: 'Patient-ok.json', resourceId: 'ok', parsed: { summary: { result: 'SUCCESS', text: '0 errors, 1 warning' }, issues: [{ severity: 'warning', location: 'Patient.name', message: 'w1' }] } },
  { fileName: 'Patient-bad.json', resourceId: 'bad', parsed: { summary: { result: 'FAILURE', text: '2 errors' }, issues: [
    { severity: 'error', location: 'Patient.gender', line: 3, col: 4, msgId: 'X', message: 'e1' },
    { severity: 'fatal', location: 'Patient', message: 'e2' },
  ] } },
  { fileName: 'Patient-none.json', resourceId: null, parsed: { summary: null, issues: [], error: 'timeout' } },
];

test('buildExamplesModel: counts, a missing result is a failure', () => {
  const m = buildExamplesModel({ fhirType: 'Patient', results: EXAMPLE_RESULTS, reportPath: '/w/examples/s/s-examples-report.md' });
  assert.equal(m.total, 3);
  assert.equal(m.passed, 1);
  assert.deepEqual(m.items.map(e => [e.fileName, e.pass, e.errors, e.warnings, e.noResult]), [
    ['Patient-ok.json', true, 0, 1, false],
    ['Patient-bad.json', false, 2, 0, false],
    ['Patient-none.json', false, 1, 0, true],
  ]);
  assert.equal(m.items[1].bySeverity.fatal.length, 1);
  assert.equal(m.items[2].error, 'timeout');
  assert.deepEqual(buildExamplesModel({ fhirType: 'Patient', results: [] }).total, 0);
});

test('renderHtmlReport: examples section on the same page, issues collapsed', () => {
  const model = buildReportModel(reportInput('x'));
  model.examples = buildExamplesModel({ fhirType: 'Patient', results: EXAMPLE_RESULTS, reportPath: 'r.md' });
  model.examplesLink = 'examples/s/s-examples-report.md';
  const html = renderHtmlReport(model);
  assert.match(html, /<h2 id="examples">Examples<\/h2>/);
  assert.match(html, /<strong>1 of 3<\/strong> without errors\. <a href="examples\/s\/s-examples-report\.md">Markdown<\/a>/);
  assert.equal(count(html, '<details class="example '), 3);
  // collapsed: no example entry is open in the markup
  assert.doesNotMatch(html, /<details class="example [a-z]+" data-status="[a-z]+" open/);
  assert.match(html, /<details class="example pass" data-status="pass"><summary><span class="badge pass">OK<\/span><span class="ex-name"><code>Patient-ok\.json<\/code> <span class="sub">id: ok<\/span><\/span><span class="ex-counts">0 errors, 1 warning<\/span>/);
  assert.match(html, /<span class="badge fail">FAIL<\/span><span class="ex-name"><code>Patient-bad\.json<\/code>/);
  assert.match(html, /2 errors, 0 warnings/);
  assert.match(html, /No validator result: timeout/);
  assert.match(html, /\(line 3, col 4\) <code>X<\/code>/);
  // the filter also covers examples; examples come after the EU profiles
  assert.match(html, /Show only failing EU profiles and examples/);
  assert.ok(html.indexOf('id="examples"') > html.indexOf('id="eu-profiles"'));

  const none = buildReportModel(reportInput('x'));
  none.examples = buildExamplesModel({ fhirType: 'Patient', results: [] });
  assert.match(renderHtmlReport(none), /<h2 id="examples">Examples<\/h2>.*No example instances found\./s);
});

test('renderHtmlReport: example values are escaped', () => {
  const model = buildReportModel(reportInput('x'));
  model.examples = buildExamplesModel({
    fhirType: EVIL,
    results: [{ fileName: EVIL, resourceId: EVIL, parsed: { summary: { result: 'FAILURE', text: EVIL }, error: EVIL, issues: [{ severity: 'error', location: EVIL, msgId: EVIL, message: EVIL }] } }],
  });
  model.examplesLink = 'javascript:alert(1)" onclick="x';
  const html = withoutInlineScript(renderHtmlReport(model));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img src=x/i);
  assert.doesNotMatch(html, RAW_HANDLER);
  assert.doesNotMatch(html, /" onclick="|href="javascript:/i);
  assert.ok(count(html, '&lt;script&gt;alert(1)&lt;/script&gt;') >= 6);
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
  // the model is returned so that --examples can add its section to the same page
  assert.equal(withHtml.reportModel.kind, 'profile');
  assert.ok(withHtml.reportModel.meta);
});

test('addExamplesToHtml rewrites the profile HTML with the examples section and a relative Markdown link', async (t) => {
  const { addExamplesToHtml } = await import('../src/commands/validate.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-ex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const htmlPath = path.join(dir, 's-report.html');
  const html = { model: buildReportModel(reportInput('x')), path: htmlPath };
  await addExamplesToHtml(html, 'Patient', {
    exampleResults: EXAMPLE_RESULTS,
    exReportPath: path.join(dir, 'examples', 's', 's-examples-report.md'),
  });
  const written = fs.readFileSync(htmlPath, 'utf8');
  assert.match(written, /<h2 id="examples">Examples<\/h2>/);
  assert.match(written, /<a href="examples\/s\/s-examples-report\.md">Markdown<\/a>/);
  assert.equal(count(written, '<details class="example '), 3);

  await addExamplesToHtml(html, 'Patient', null);
  assert.match(fs.readFileSync(htmlPath, 'utf8'), /No example instances found\./);
});

test('obligations: SHOULD violations get their own heading after SHALL (Markdown and HTML) and still fail', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-obl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = reportInput(path.join(dir, 'r-report.md'));
  const [[euCanonical, violations]] = [...input.obligationViolationsByEuCanonical];
  input.obligationViolationsByEuCanonical.set(euCanonical, [
    { euElementId: 'Patient.telecom', obligationCode: 'SHOULD:able-to-populate', matchType: 'exact', maxIsZero: false, missingMustSupport: true, inputCardinality: '0..*', inputMustSupport: false },
    ...violations,
  ]);
  await generateReport(input);
  const md = fs.readFileSync(input.reportPath, 'utf8');
  assert.match(md, /## ⚠️ Obligation Check \(able-to-populate\)/);
  assert.doesNotMatch(md, /Obligation Check \(SHALL:able-to-populate\)/);
  const shall = md.indexOf('#### SHALL:able-to-populate');
  const should = md.indexOf('#### SHOULD:able-to-populate');
  assert.ok(shall > 0 && should > shall, 'SHALL table first, then SHOULD');
  assert.ok(md.indexOf('Patient.telecom') > should, 'SHOULD row is under the SHOULD heading');

  const html = renderHtmlReport(buildReportModel(input));
  assert.match(html, /<h4>Obligation check \(able-to-populate\)<\/h4>/);
  assert.ok(html.indexOf('<h5>SHALL:able-to-populate</h5>') < html.indexOf('<h5>SHOULD:able-to-populate</h5>'));
});
