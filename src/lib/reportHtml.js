import fs from 'node:fs';
import { SEVERITIES } from './reportModel.js';

/**
 * HTML renderer for the report model (see reportModel.js).
 *
 * Produces ONE self-contained file: inline CSS, the logo as a data URI and a
 * few lines of inline JavaScript for progressive enhancement (filter, expand
 * all). Without JavaScript the page is complete and readable.
 *
 * Every value that comes from a profile, a package or the validator is passed
 * through esc() before it reaches the markup; the inline script never writes
 * markup (no innerHTML), it only toggles `hidden` and `open`.
 */

// ── Escaping helpers ───────────────────────────────────────────────────────

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes a value for HTML text and double- or single-quoted attribute values. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

/** A code span with escaped content. */
function code(value) {
  return `<code>${esc(value)}</code>`;
}

/**
 * Returns an escaped href for absolute http(s) URLs, or null for anything else
 * (javascript:, data:, relative paths, URLs with whitespace or control characters).
 */
function safeHref(url) {
  const s = String(url ?? '');
  if (!/^https?:\/\/[^\s/?#]+[^\s]*$/i.test(s)) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null; // eslint-disable-line no-control-regex
  return esc(s);
}

/** "1 profile" / "2 profiles". */
function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// ── Logo ───────────────────────────────────────────────────────────────────

let logoCache;

/** The shipped Gefyra logo as a data URI, or null when the asset is missing. */
function logoDataUri() {
  if (logoCache === undefined) {
    try {
      const png = fs.readFileSync(new URL('../../assets/gefyra-logo.png', import.meta.url));
      logoCache = `data:image/png;base64,${png.toString('base64')}`;
    } catch {
      logoCache = null;
    }
  }
  return logoCache;
}

// ── Styles and script ──────────────────────────────────────────────────────

const CSS = `
:root{
  --accent:#d32e22;--accent-text:#b3261c;--accent-soft:#fdecea;
  --pass:#1a7f37;--pass-text:#1a7f37;--pass-soft:#e6f4ea;
  --warn:#9a6700;--warn-soft:#fff4d6;--on-warn:#ffffff;
  --info:#0b5cad;--info-soft:#e8f1fb;
  --bg:#f6f7f9;--surface:#ffffff;--surface-2:#f0f2f5;--text:#1f2328;--muted:#57606a;--border:#d8dee4;
  --shadow:0 1px 2px rgba(31,35,40,.06),0 4px 16px rgba(31,35,40,.06);
  --radius:12px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root{
  --accent-text:#ff8a80;--accent-soft:#3a1714;
  --pass:#2ea043;--pass-text:#56d364;--pass-soft:#12261a;
  --warn:#d29922;--warn-soft:#2e2510;--on-warn:#1f2328;
  --info:#58a6ff;--info-soft:#0f2238;
  --bg:#0f1115;--surface:#171a21;--surface-2:#1f232c;--text:#e6e8eb;--muted:#9aa4b2;--border:#2d333d;
  --shadow:none;
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px 48px}
header.top{background:var(--surface);border-bottom:3px solid var(--accent)}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:16px;padding-bottom:16px}
.logo{display:inline-flex;align-items:center;background:#fff;border-radius:8px;padding:4px 8px}
.logo img{display:block;height:36px;width:auto}
.logo-text{font-weight:700;font-size:20px;color:#3a3a3a}
.eyebrow{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
h1{font-size:28px;line-height:1.2;margin:32px 0 4px;overflow-wrap:anywhere}
h2{font-size:20px;margin:40px 0 12px}
h3{font-size:17px;margin:0;overflow-wrap:anywhere}
h4{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:20px 0 8px}
p{margin:8px 0}
code{font-family:var(--mono);font-size:.88em;background:var(--surface-2);border-radius:4px;padding:1px 5px;overflow-wrap:anywhere}
.kicker{margin:32px 0 0}
h1.after-kicker{margin-top:4px}
.canonical{color:var(--muted);margin:0 0 20px}
.canonical code{background:none;padding:0;font-size:13px}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0;font-size:14px}
dl.meta dt{color:var(--muted)}
dl.meta dd{margin:0;overflow-wrap:anywhere}
.verdict{display:flex;gap:16px;align-items:center;margin:28px 0 20px;padding:20px 24px;border-radius:var(--radius);background:var(--surface);border:1px solid var(--border);border-left:6px solid var(--muted);box-shadow:var(--shadow)}
.verdict.pass{border-left-color:var(--pass);background:var(--pass-soft)}
.verdict.fail{border-left-color:var(--accent);background:var(--accent-soft)}
.verdict-icon{flex:none;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-size:24px;font-weight:700;color:#fff;background:var(--muted)}
.verdict.pass .verdict-icon{background:var(--pass)}
.verdict.fail .verdict-icon{background:var(--accent)}
.verdict-title{font-size:20px;font-weight:700;margin:0}
.verdict-sub{margin:2px 0 0;color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:0 0 8px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow)}
.tile .num{display:block;font-size:28px;font-weight:700;line-height:1.1}
.tile .label{color:var(--muted);font-size:13px}
.tile.pass .num{color:var(--pass-text)}
.tile.fail .num{color:var(--accent-text)}
.tile.warn .num{color:var(--warn)}
.toolbar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin:24px 0 0;font-size:14px}
.toolbar[hidden]{display:none}
.toolbar button{font:inherit;padding:5px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer}
.toolbar button:hover{border-color:var(--muted)}
.toolbar label{display:inline-flex;gap:6px;align-items:center;cursor:pointer}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin:0 0 16px;box-shadow:var(--shadow);overflow:hidden}
.card[hidden]{display:none}
.card-head{display:flex;gap:12px;align-items:flex-start;padding:16px 20px;border-bottom:1px solid var(--border)}
.card.fail .card-head{border-left:4px solid var(--accent)}
.card.pass .card-head{border-left:4px solid var(--pass)}
.card-head .titles{min-width:0}
.card-head .titles p{margin:2px 0 0;font-size:13px;color:var(--muted)}
.card-head .titles p code{background:none;padding:0}
.card-body{padding:4px 20px 18px}
.card-body > h4:first-child{margin-top:16px}
.badge{flex:none;display:inline-block;min-width:52px;text-align:center;font-size:12px;font-weight:700;letter-spacing:.06em;padding:3px 8px;border-radius:999px;color:#fff;background:var(--muted)}
.badge.pass{background:var(--pass)}
.badge.fail{background:var(--accent)}
.badge.error{background:var(--warn);color:var(--on-warn)}
.ok{color:var(--muted);margin:16px 0 0}
.table-wrap{overflow-x:auto;margin:0 -4px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--border)}
th{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
tr:last-child td{border-bottom:none}
tr[hidden]{display:none}
td.num,th.num{text-align:right;white-space:nowrap}
.dash{color:var(--muted)}
.note{font-size:13px;color:var(--muted)}
details.hint{margin-top:4px;font-size:13px;color:var(--muted)}
details.hint summary{cursor:pointer;color:var(--info);width:max-content;max-width:100%}
details.hint p{margin:4px 0 0}
.panel{border-radius:10px;padding:12px 16px;margin:12px 0 0;font-size:14px}
.panel.info{background:var(--info-soft)}
.panel.warn{background:var(--warn-soft)}
.panel h4{margin:0 0 6px;color:var(--text)}
.howto{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:4px 20px;margin:24px 0 0}
.howto > summary{cursor:pointer;font-weight:600;padding:12px 0}
.howto dl{margin:0 0 12px}
.howto dt{font-weight:600;margin-top:12px}
.howto dd{margin:2px 0 0}
details.other{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:0 20px}
details.other > summary{cursor:pointer;font-weight:600;padding:14px 0}
details.sev{border-top:1px solid var(--border)}
details.sev > summary{cursor:pointer;padding:10px 0;font-weight:600}
.issues{list-style:none;margin:0 0 12px;padding:0}
.issues li{padding:10px 0;border-top:1px dashed var(--border)}
.issues li:first-child{border-top:none}
.issue-loc{font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.issue-msg{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.pill{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;border-radius:999px;padding:1px 8px;margin-left:6px;vertical-align:1px}
.pill.fatal,.pill.error{background:var(--accent-soft);color:var(--accent-text)}
.pill.warning{background:var(--warn-soft);color:var(--warn)}
.pill.information{background:var(--info-soft);color:var(--info)}
.chips{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0;padding:0}
.chip{font-size:12px;border-radius:999px;padding:2px 10px;border:1px solid var(--border);white-space:nowrap}
.chip.pass{color:var(--pass-text);border-color:var(--pass)}
.chip.fail{color:var(--accent-text);border-color:var(--accent)}
.sub{display:block;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
a{color:var(--info)}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)}
@media (max-width:640px){
  h1{font-size:22px;margin-top:24px}
  .verdict{padding:16px}
  .card-head,.card-body{padding-left:14px;padding-right:14px}
  dl.meta{grid-template-columns:1fr;gap:0}
  dl.meta dd{margin-bottom:8px}
  header.top .eyebrow{display:none}
}
@media print{
  :root{--bg:#fff;--surface:#fff;--shadow:none}
  body{font-size:12px}
  .toolbar{display:none !important}
  .card,.tile,.verdict{box-shadow:none;break-inside:avoid}
  .card[hidden],tr[hidden]{display:block}
  tr[hidden]{display:table-row}
  details > summary{list-style:none}
  details::details-content{content-visibility:visible;display:block}
  a{color:inherit;text-decoration:none}
}
`;

// Progressive enhancement only: toggles `hidden`/`open`, never writes markup.
const SCRIPT = `
(function(){
  var bar=document.getElementById('toolbar');
  if(!bar)return;
  bar.hidden=false;
  var all=function(open){document.querySelectorAll('details').forEach(function(d){d.open=open;});};
  var only=document.getElementById('only-failing');
  if(only)only.addEventListener('change',function(){
    document.querySelectorAll('[data-status]').forEach(function(el){
      el.hidden=only.checked&&el.getAttribute('data-status')==='pass';
    });
  });
  var ex=document.getElementById('expand-all');if(ex)ex.addEventListener('click',function(){all(true);});
  var co=document.getElementById('collapse-all');if(co)co.addEventListener('click',function(){all(false);});
  window.addEventListener('beforeprint',function(){all(true);});
})();
`;

// ── Explanations (plain language, for workshops) ───────────────────────────

/** Short explanation of a detail issue (reportModel.parseSliceIssue kinds). */
function issueHint(issue, path) {
  switch (issue.kind) {
    case 'cardinality':
      return issue.bound === 'min'
        ? `The EU profile sets min ${issue.expected} for this element, your profile min ${issue.actual}. A complying profile must be at least as strict: its minimum must not be lower.`
        : `The EU profile sets max ${issue.expected} for this element, your profile max ${issue.actual}. A complying profile must be at least as strict: its maximum must not be higher.`;
    case 'constraint': {
      const where = path
        ? 'The EU profile declares this rule (a FHIRPath invariant) on the element shown; your profile does not declare it.'
        : 'The EU profile declares this rule (a FHIRPath invariant); your profile does not declare it. The validator names no element, and the EU profile declares the rule on several elements (or none could be found), so no single path can be shown.';
      const auto = issue.autoResolvable
        ? 'The rule has the ".exists() or …" form that this tool resolves automatically, but your profile\'s minimum cardinalities do not guarantee it.'
        : 'The automatic resolution of this tool only covers rules of the form "a.exists() or b.exists() …" that minimum cardinalities guarantee; this rule has a different form, so it was not evaluated and stays a finding.';
      return `${where} ${auto} To fix it, add the constraint to your profile.`;
    }
    case 'slicing':
      return 'The EU profile slices this element: it splits the repetitions into named parts (slices) with their own rules, identified by a discriminator. Your profile defines no slicing on this element, so the validator cannot check it against the EU slices. Add a slicing with a compatible discriminator to your profile.';
    default:
      return null;
  }
}

/** HTML of a detail issue's main text (mirrors the Markdown wording). */
function issueText(issue) {
  switch (issue.kind) {
    case 'cardinality':
      return `${esc(issue.bound)}: is ${code(issue.actual)}, expected ${code(issue.expected)}`;
    case 'constraint':
      return `Constraint missing: ${code(issue.expression)}`;
    case 'slicing':
      return 'No slicing found, target profile expects slicing';
    default:
      return esc(issue.text);
  }
}

const OBLIGATION_PROBLEM_HTML = {
  notFound: 'Element not found in profile',
  maxZero: '<code>max: 0</code> — element prohibited',
  missingMustSupport: 'MustSupport missing',
};

const SEVERITY_LABELS = { fatal: 'Fatal', error: 'Errors', warning: 'Warnings', information: 'Information' };
const SEVERITY_COUNT = { fatal: ['fatal', 'fatal'], error: ['error', 'errors'], warning: ['warning', 'warnings'], information: ['information', 'information'] };

// ── Shared page parts ──────────────────────────────────────────────────────

function pageHead(title) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${esc(title)}</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body>',
  ].join('\n');
}

function topBar(eyebrow) {
  const logo = logoDataUri();
  const mark = logo
    ? `<span class="logo"><img src="${logo}" alt="Gefyra" width="80" height="36"></span>`
    : '<span class="logo"><span class="logo-text">gefyra</span></span>';
  return `<header class="top"><div class="wrap">${mark}<span class="eyebrow">${esc(eyebrow)}</span></div></header>`;
}

function metaList(rows) {
  const items = rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${value}</dd>`)
    .join('');
  return `<dl class="meta">${items}</dl>`;
}

function toolRows(meta) {
  const tool = meta && meta.tool;
  const euPackages = (meta && meta.euPackages) || [];
  return [
    ['Tool', tool && tool.name ? `${esc(tool.name)}${tool.version ? ` ${esc(tool.version)}` : ''}` : null],
    ['Validator', tool && tool.validatorVersion ? `HL7 FHIR Validator ${esc(tool.validatorVersion)}` : null],
    ['EU packages', euPackages.length
      ? euPackages.map(p => code(p.version ? `${p.packageName}#${p.version}` : p.packageName)).join(' ')
      : null],
  ];
}

function verdictBanner(state, title, sub) {
  const icon = state === 'pass' ? '✓' : state === 'fail' ? '✕' : '–';
  return `<section class="verdict ${state}" aria-label="Verdict"><span class="verdict-icon" aria-hidden="true">${icon}</span>` +
    `<div><p class="verdict-title">${esc(title)}</p><p class="verdict-sub">${esc(sub)}</p></div></section>`;
}

function tiles(items) {
  return `<section class="tiles" aria-label="Summary">${items.map(([num, label, cls]) =>
    `<div class="tile${cls ? ` ${cls}` : ''}"><span class="num">${esc(num)}</span><span class="label">${esc(label)}</span></div>`).join('')}</section>`;
}

function toolbar(filterLabel, { expand = true } = {}) {
  return '<div class="toolbar" id="toolbar" hidden>' +
    `<label><input type="checkbox" id="only-failing"> ${esc(filterLabel)}</label>` +
    (expand
      ? '<button type="button" id="expand-all">Expand all</button><button type="button" id="collapse-all">Collapse all</button>'
      : '') +
    '</div>';
}

function footer(meta, date, extra = '') {
  const tool = meta && meta.tool;
  const href = tool ? safeHref(tool.homepage) : null;
  const name = tool && tool.name ? esc(tool.name) : 'complies-with-eu';
  const generator = href ? `<a href="${href}">${name}</a>` : name;
  return `<footer>Generated by ${generator}${tool && tool.version ? ` ${esc(tool.version)}` : ''} on ${esc(date)}.${extra}</footer>`;
}

function pageEnd() {
  return `<script>${SCRIPT}</script>\n</body>\n</html>\n`;
}

// ── Single-profile report ──────────────────────────────────────────────────

function howToRead() {
  return `<details class="howto" open><summary>How to read this report</summary><dl>
<dt>compliesWithProfile</dt>
<dd>A copy of your profile gets one <code>compliesWithProfile</code> extension per selected EU profile. The HL7 FHIR Validator then checks each claim: your profile must be at least as strict as the EU profile, so every instance that is valid against your profile is also valid against the EU profile.</dd>
<dt>PASS and FAIL</dt>
<dd><strong>PASS</strong>: the validator accepted the claim and the obligation check found nothing. <strong>FAIL</strong>: the validator rejected the claim, or an element the EU profile marks <code>SHALL:able-to-populate</code> is missing, prohibited or not MustSupport in your profile. Each failing card lists the reasons.</dd>
<dt>Typical findings</dt>
<dd><em>min/max: is X, expected Y</em>: your profile allows more or fewer repetitions than the EU profile.<br>
<em>Constraint missing</em>: the EU profile declares a FHIRPath rule (invariant) that your profile does not declare. "—" as path means the rule cannot be pinned to one element.<br>
<em>No slicing found, target profile expects slicing</em>: the EU profile splits the element into named slices; your profile has no slicing there.<br>
Select <em>What does this mean?</em> under a finding for an explanation.</dd>
<dt>Automatically resolved and other results</dt>
<dd>Constraints of the form <code>a.exists() or b.exists()</code> that your minimum cardinalities guarantee are resolved automatically and shown as information. "Other validation results" are validator messages that are not about compliesWithProfile; they do not change the verdict.</dd>
</dl></details>`;
}

function detailsTable(items) {
  const rows = items.map(({ path, issue, count }) => {
    const hint = issueHint(issue, path);
    const hintHtml = hint
      ? `<details class="hint"><summary>What does this mean?</summary><p>${esc(hint)}</p></details>`
      : '';
    return `<tr><td>${path ? code(path) : '<span class="dash" title="No element path available">—</span>'}</td>` +
      `<td>${issueText(issue)}${hintHtml}</td><td class="num">${count}×</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr><th scope="col">Path</th><th scope="col">Issue</th><th scope="col" class="num">Reported</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function obligationTable(violations, profileTitle) {
  const rows = violations.map((v) => {
    const problems = v.problems.map(k => OBLIGATION_PROBLEM_HTML[k]).join(', ');
    const card = v.notFound || v.cardinality == null ? '<span class="dash">—</span>' : code(v.cardinality);
    const ms = v.notFound ? '<span class="dash">—</span>' : (v.mustSupport ? 'yes' : '<strong>no</strong>');
    return `<tr><td>${code(v.euElementId)}</td><td>${code(v.obligationCode)}</td><td>${problems}</td><td>${card}</td><td>${ms}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr><th scope="col">EU element</th><th scope="col">Obligation</th><th scope="col">Issue</th>` +
    `<th scope="col">Cardinality <span class="sub">${esc(profileTitle)}</span></th><th scope="col">MustSupport <span class="sub">${esc(profileTitle)}</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function autoResolvedTable(items) {
  const rows = items.map(a =>
    `<tr><td>${code(a.basePath)}</td><td>${code(a.expression)}</td><td>${esc(a.matchedChild)}</td></tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th scope="col">Element</th><th scope="col">Constraint</th><th scope="col">Fulfilled by</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function euProfileCard(p, model) {
  const status = p.pass ? 'pass' : 'fail';
  const parts = [];

  if (p.compliesWithFailed) {
    parts.push('<h4>compliesWithProfile check (HL7 FHIR Validator)</h4>');
    parts.push(p.details.length
      ? detailsTable(p.details)
      : '<p class="note">The validator rejected the claim but reported no details.</p>');
  }

  if (p.obligationViolations.length) {
    parts.push(`<div class="panel warn"><h4>Obligation check (SHALL:able-to-populate)</h4>` +
      '<p class="note">The HL7 FHIR Validator does not check obligations or MustSupport. This tool checks that every element the EU profile marks <code>SHALL:able-to-populate</code> exists in your profile, is MustSupport and has a maximum cardinality above 0.</p>' +
      `${obligationTable(p.obligationViolations, model.title)}</div>`);
  }

  if (p.autoResolved.length) {
    parts.push('<div class="panel info"><h4>Automatically resolved (information)</h4>' +
      '<p class="note">Not declared by your profile, but guaranteed by its minimum cardinalities. Excluded from the verdict.</p>' +
      `${autoResolvedTable(p.autoResolved)}</div>`);
  }

  if (p.pass) {
    parts.unshift('<p class="ok">No deviations found: the validator accepted the claim and the obligation check found no violation.</p>');
  }

  return `<article class="card ${status}" data-status="${status}">` +
    `<div class="card-head"><span class="badge ${status}">${p.pass ? 'PASS' : 'FAIL'}</span>` +
    `<div class="titles"><h3>${esc(p.name)}</h3><p>${code(p.display)}</p></div></div>` +
    `<div class="card-body">${parts.join('')}</div></article>`;
}

function otherResults(otherIssues) {
  if (!otherIssues.total) return '';
  const { bySeverity } = otherIssues;
  const counts = SEVERITIES.filter(s => bySeverity[s].length)
    .map(s => plural(bySeverity[s].length, ...SEVERITY_COUNT[s])).join(', ');
  const groups = SEVERITIES.filter(s => bySeverity[s].length).map((sev) => {
    const items = bySeverity[sev].map((i) => {
      const loc = [
        i.location ? esc(i.location) : '<em>no location</em>',
        i.line ? `(line ${esc(i.line)}, col ${esc(i.col)})` : '',
        i.msgId ? code(i.msgId) : '',
      ].filter(Boolean).join(' ');
      return `<li><div class="issue-loc">${loc}</div><p class="issue-msg">${esc(i.message)}</p></li>`;
    }).join('');
    return `<details class="sev" open><summary>${esc(SEVERITY_LABELS[sev])} <span class="pill ${sev}">${bySeverity[sev].length}</span></summary><ul class="issues">${items}</ul></details>`;
  }).join('');
  return '<h2 id="other">Other validation results</h2>' +
    '<p class="note">Validator messages that are not about compliesWithProfile. They are listed for completeness and do not change the verdict.</p>' +
    `<details class="other"><summary>${esc(plural(otherIssues.total, 'message'))}: ${esc(counts)}</summary>${groups}</details>`;
}

/**
 * Renders the single-profile report model as a self-contained HTML document.
 *
 * @param {object} model - Result of reportModel.buildReportModel
 * @returns {string}
 */
function renderHtmlReport(model) {
  const { summary } = model;
  const state = summary.total === 0 ? 'none' : (summary.pass ? 'pass' : 'fail');
  const verdictTitle = state === 'none'
    ? 'No EU profiles checked'
    : state === 'pass' ? 'Compliant with all checked EU profiles' : 'Not compliant';
  const verdictSub = state === 'none'
    ? 'No EU profile was selected for this profile.'
    : `${summary.compliant} of ${summary.total} checked EU profiles fulfilled` +
      (summary.nonCompliant ? `, ${summary.nonCompliant} not fulfilled.` : '.');

  const out = [
    pageHead(`Compliance report: ${model.title}`),
    topBar('EU compliance report'),
    '<main class="wrap">',
    `<h1>${esc(model.title)}</h1>`,
    `<p class="canonical">${code(model.canonical)}</p>`,
    metaList([
      ['Package', code(model.packageSpec)],
      ['Date', esc(model.date)],
      ...toolRows(model.meta),
    ]),
    verdictBanner(state, verdictTitle, verdictSub),
    tiles([
      [summary.total, 'EU profiles checked'],
      [summary.compliant, 'fulfilled', 'pass'],
      [summary.nonCompliant, 'not fulfilled', summary.nonCompliant ? 'fail' : ''],
      [summary.obligationViolations, 'obligation violations', summary.obligationViolations ? 'warn' : ''],
    ]),
    howToRead(),
    toolbar('Show only failing EU profiles'),
    '<h2 id="eu-profiles">EU profiles</h2>',
    model.euProfiles.length
      ? model.euProfiles.map(p => euProfileCard(p, model)).join('\n')
      : '<p class="note">No EU profiles were checked.</p>',
    otherResults(model.otherIssues),
    footer(model.meta, model.date, model.validatorSummary ? ` Validator summary: ${esc(model.validatorSummary)}` : ''),
    '</main>',
    pageEnd(),
  ];
  return out.join('\n');
}

// ── Package report ─────────────────────────────────────────────────────────

/**
 * Renders the package report model (reportModel.buildPackageModel) as HTML.
 * Links to the per-profile reports are relative (same directory).
 *
 * @param {object} model
 * @returns {string}
 */
function renderPackageHtml(model) {
  const { summary } = model;
  const state = summary.total === 0 ? 'none' : (summary.pass ? 'pass' : 'fail');
  const verdictTitle = state === 'none'
    ? 'No profiles validated'
    : state === 'pass' ? 'All profiles compliant' : 'Not all profiles compliant';
  const verdictSub = state === 'none'
    ? 'The package has no profiles with EU counterparts, or all were skipped.'
    : `${summary.compliant} of ${summary.total} profiles compliant` +
      (summary.nonCompliant ? `, ${summary.nonCompliant} non-compliant` : '') +
      (summary.errored ? `, ${summary.errored} could not be validated` : '') + '.';

  const rows = model.profiles.map((p) => {
    const status = p.error ? 'error' : (p.pass ? 'pass' : 'fail');
    const label = p.error ? 'ERROR' : (p.pass ? 'PASS' : 'FAIL');
    const chips = p.compliance.length
      ? `<ul class="chips">${p.compliance.map(c =>
        `<li class="chip ${c.pass ? 'pass' : 'fail'}" title="${esc(c.euCanonical)}">${c.pass ? '✓' : '✕'} ${esc(c.name)}</li>`).join('')}</ul>`
      : '<span class="dash">—</span>';
    const file = encodeURIComponent(String(p.slug ?? ''));
    const links = `<a href="${file}-report.html">HTML</a> · <a href="${file}-report.md">Markdown</a>`;
    const error = p.error ? `<span class="sub">${esc(p.error)}</span>` : '';
    return `<tr data-status="${p.pass ? 'pass' : 'fail'}"><td><strong>${esc(p.name)}</strong><span class="sub">${esc(p.canonical)}</span>${error}</td>` +
      `<td>${chips}</td><td><span class="badge ${status}">${label}</span></td><td>${links}</td></tr>`;
  }).join('');

  const table = model.profiles.length
    ? `<div class="card"><div class="table-wrap"><table><thead><tr><th scope="col">Profile</th><th scope="col">EU profiles</th><th scope="col">Verdict</th><th scope="col">Report</th></tr></thead><tbody>${rows}</tbody></table></div></div>`
    : '<p class="note">No profiles were validated.</p>';

  return [
    pageHead(`Package compliance report: ${model.packageSpec}`),
    topBar('EU compliance report'),
    '<main class="wrap">',
    '<p class="eyebrow kicker">Package</p>',
    `<h1 class="after-kicker">${esc(model.packageSpec)}</h1>`,
    metaList([['Date', esc(model.date)], ...toolRows(model.meta)]),
    verdictBanner(state, verdictTitle, verdictSub),
    tiles([
      [summary.total, 'profiles'],
      [summary.compliant, 'compliant', 'pass'],
      [summary.nonCompliant, 'non-compliant', summary.nonCompliant ? 'fail' : ''],
      [summary.errored, 'with errors', summary.errored ? 'warn' : ''],
    ]),
    toolbar('Show only profiles that are not compliant', { expand: false }),
    '<h2 id="profiles">Profiles</h2>',
    table,
    footer(model.meta, model.date),
    '</main>',
    pageEnd(),
  ].join('\n');
}

// ── Error report ───────────────────────────────────────────────────────────

/**
 * Renders the HTML error report of a profile that could not be processed.
 *
 * @param {object} opts - { canonical, packageSpec, message, date, meta }
 * @returns {string}
 */
function renderHtmlErrorReport({ canonical, packageSpec, message, date, meta = null }) {
  const title = String(canonical ?? '').split('/').pop();
  return [
    pageHead(`Compliance report: ${title} (error)`),
    topBar('EU compliance report'),
    '<main class="wrap">',
    `<h1>${esc(title)}</h1>`,
    `<p class="canonical">${code(canonical)}</p>`,
    metaList([['Package', code(packageSpec)], ['Date', esc(date)], ...toolRows(meta)]),
    verdictBanner('fail', 'Processing error', 'This profile could not be validated. Check the inputs and make sure the package can be downloaded.'),
    `<div class="card"><div class="card-body"><p class="issue-msg">${esc(message)}</p></div></div>`,
    footer(meta, date),
    '</main>',
    pageEnd(),
  ].join('\n');
}

export {
  esc,
  safeHref,
  logoDataUri,
  issueHint,
  renderHtmlReport,
  renderPackageHtml,
  renderHtmlErrorReport,
};
