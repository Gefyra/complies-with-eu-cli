'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  detectPhase,
  PHASES,
  extractResultInfo,
  tailLines,
  formatValidatorError,
  formatValidatorErrorShort,
  createValidatorError,
  oneLineError,
  createOutputHandler,
  createProgress,
} = require('../src/lib/validatorOutput');
const {
  executeValidator,
  spawnValidator,
  normalizeRunOptions,
  parseValidatorOutput,
} = require('../src/lib/javaValidator');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-vout-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SAMPLE_OUTPUT = [
  'FHIR Validation tool Version 6.3.0 (Git# abc). Built 2026-01-01',
  '  Java:   21.0.2 from /usr/lib/jvm on amd64 (64bit). 4096MB available',
  'Loading',
  '  Load FHIR v4.0.1 from hl7.fhir.r4.core#4.0.1 - 4576 resources (00:03.123)',
  '  Terminology server http://tx.fhir.org - Version 1.0.0 (00:01.234)',
  '  Get set...  go (00:00.123)',
  'Validating',
  '  Validate /work/Patient-modified.json',
  ...Array.from({ length: 30 }, (_, i) => `  Information @ StructureDefinition.snapshot.element[${i}]: note ${i} {INFO_${i}}`),
  'Done. Times: Loading: 00:12.345, validation: 00:03.456. Memory = 1Gb',
  '*FAILURE*: 34 errors, 1 warnings, 101 notes',
  "  Error @ StructureDefinition: The profile does not comply with claimed profile 'http://x/eu' {SD_EXTENSION_COMPLIES_WITH_ERROR}",
  '',
].join('\n');

/** Minimal writable stream that records what is written (not a TTY). */
function recorder() {
  const chunks = [];
  return { chunks, write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

/**
 * Fake child_process.spawn: emits the given output in uneven chunks (lines split
 * across chunks), then exits with `code`.
 */
function fakeSpawn({ output = '', code = 0, signal = null, startError = null } = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.exitCode = null;
    proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    setImmediate(() => {
      if (startError) {
        proc.emit('error', startError);
        return;
      }
      for (let i = 0; i < output.length; i += 37) {
        const stream = (i / 37) % 2 === 0 ? proc.stdout : proc.stderr;
        stream.emit('data', Buffer.from(output.slice(i, i + 37)));
      }
      proc.exitCode = code;
      proc.emit('exit', code, signal);
      proc.emit('close', code, signal);
    });
    return proc;
  };
  fn.calls = calls;
  return fn;
}

test('detectPhase: recognises coarse validator phases only', () => {
  assert.equal(PHASES[detectPhase('Loading')].label, 'Loading packages');
  assert.equal(PHASES[detectPhase('  Load hl7.terminology#5.5.0 - 4000 resources')].label, 'Loading packages');
  assert.equal(PHASES[detectPhase('  Terminology server http://tx.fhir.org')].label, 'Connecting to terminology server');
  assert.equal(PHASES[detectPhase('\x1b[0;39m  Validate /x/a.json')].label, 'Validating');
  assert.equal(detectPhase('  Information @ X: something {ID}'), -1);
  assert.equal(detectPhase('*FAILURE*: 1 errors, 0 warnings, 0 notes'), -1);
});

test('createOutputHandler: does not mirror output unless verbose; collects everything', () => {
  const written = [];
  const phases = [];
  const quiet = createOutputHandler({ write: (t) => written.push(t), onPhase: (p) => phases.push(p) });
  for (let i = 0; i < SAMPLE_OUTPUT.length; i += 13) quiet.onData(Buffer.from(SAMPLE_OUTPUT.slice(i, i + 13)));
  quiet.flush();
  assert.deepEqual(written, [], 'nothing mirrored by default');
  assert.equal(quiet.getOutput(), SAMPLE_OUTPUT);
  assert.deepEqual(phases, ['Loading packages', 'Connecting to terminology server', 'Validating']);
  assert.equal(quiet.getPhase(), 'Validating');

  const mirrored = [];
  const verbose = createOutputHandler({ verbose: true, write: (t) => mirrored.push(t) });
  verbose.onData('abc\n');
  verbose.onData(Buffer.from('def'));
  assert.equal(mirrored.join(''), 'abc\ndef');
});

test('createOutputHandler: IG packages loaded after the terminology server show "Loading packages" again', () => {
  // Head of a real validator_cli 6.7.4 log (paths anonymised): the terminology
  // server line comes after the core packages, the -ig packages load after it.
  const real = fs.readFileSync(path.join(__dirname, 'fixtures', 'validator-startup-6.7.4.log'), 'utf8');
  const phases = [];
  const h = createOutputHandler({ onPhase: (p) => phases.push(p) });
  for (let i = 0; i < real.length; i += 53) h.onData(Buffer.from(real.slice(i, i + 53)));
  assert.deepEqual(phases, ['Loading packages', 'Connecting to terminology server', 'Loading packages']);
  assert.equal(h.getPhase(), 'Loading packages', 'label follows the IG loading after the terminology line');

  // "Validating" is final: later Load / Terminology lines do not move the label back
  h.onData('  Get set...  go (00:00.123)\nValidating\n  Load late.package#1.0.0\n  Terminology server x\n');
  h.flush();
  assert.deepEqual(phases.slice(3), ['Validating']);
  assert.equal(h.getPhase(), 'Validating');
});

test('createOutputHandler: maxChars keeps only the tail in memory', () => {
  const h = createOutputHandler({ maxChars: 10 });
  for (let i = 0; i < 20; i++) h.onData(`line${i}\n`);
  assert.ok(h.getOutput().length <= 20);
  assert.match(h.getOutput(), /line19\n$/);
});

test('extractResultInfo and tailLines', () => {
  const info = extractResultInfo(SAMPLE_OUTPUT);
  assert.equal(info.summaryLine, '*FAILURE*: 34 errors, 1 warnings, 101 notes');
  assert.match(info.doneLine, /^Done\. Times: Loading/);
  assert.equal(info.summaryCount, 1);

  const tail = tailLines('a\n\x1b[31mb\x1b[0m\n\n c  \n', 2);
  assert.deepEqual(tail, ['b', ' c']);
  assert.equal(tailLines('', 5).length, 0);
});

test('extractResultInfo: validator 7.x "Success:" summary', () => {
  const info = extractResultInfo('Validating\nSuccess: 0 errors, 1 warnings, 4 notes\n  Warning @ X: y\nDone. Times: Loading: 00:01.000\n');
  assert.equal(info.summaryLine, 'Success: 0 errors, 1 warnings, 4 notes');
  assert.equal(info.summaryCount, 1);
});

test('formatValidatorError: includes exit code, the last 20 lines and the log path', () => {
  const out = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const msg = formatValidatorError({ reason: 'produced no result summary', code: 1, rawOutput: out, logPath: '/w/x-raw.log' });
  assert.match(msg, /^FHIR Java Validator exited with code 1 and produced no result summary\./);
  assert.match(msg, /Last 20 line\(s\) of validator output:/);
  assert.ok(msg.includes('line 49') && msg.includes('line 30'));
  assert.ok(!msg.includes('line 29'));
  assert.match(msg, /Full validator output: \/w\/x-raw\.log$/);

  const sig = formatValidatorError({ reason: 'x', signal: 'SIGKILL', rawOutput: '' });
  assert.match(sig, /terminated by signal SIGKILL/);
  assert.match(sig, /no output/);

  const server = formatValidatorError({ subject: 'FHIR Java Validator server', reason: 'did not become ready (timeout)' });
  assert.match(server, /^FHIR Java Validator server did not become ready \(timeout\)\./);
});

test('formatValidatorErrorShort, createValidatorError and oneLineError give a single line', () => {
  assert.equal(
    formatValidatorErrorShort({ reason: 'produced no result summary', code: 137, logPath: '/w/a.log' }),
    'FHIR Java Validator produced no result summary (exit code 137). Full validator output: /w/a.log',
  );
  assert.equal(formatValidatorErrorShort({ reason: 'x', signal: 'SIGKILL' }), 'FHIR Java Validator x (terminated by signal SIGKILL).');

  const err = createValidatorError({ reason: 'produced no result summary', code: 1, rawOutput: 'a\nb\nc\n', logPath: '/w/b.log' });
  assert.ok(err.message.split('\n').length > 3, 'message keeps the tail');
  assert.equal(oneLineError(err), err.shortMessage);
  assert.ok(!oneLineError(err).includes('\n'));

  // Plain errors: first line plus the log line, if any
  assert.equal(oneLineError(new Error('boom')), 'boom');
  assert.equal(oneLineError(new Error('Header.\nLast lines:\n    x\nFull validator output: /w/c.log')), 'Header. Full validator output: /w/c.log');
  assert.equal(oneLineError(new Error('Header.\n    stack')), 'Header.');
});

test('createProgress: non-TTY prints one line per phase, no spinner frames', () => {
  const stream = recorder();
  const p = createProgress({ text: 'Running HL7 FHIR Validator', stream });
  p.phase('Loading packages');
  p.phase('Loading packages');
  p.phase('Validating');
  p.succeed('done');
  const lines = stream.text().split('\n').filter(Boolean);
  assert.equal(lines.length, 4, stream.text());
  assert.match(lines[0], /Running HL7 FHIR Validator\.\.\./);
  assert.match(lines[1], /Loading packages/);
  assert.match(lines[2], /Validating/);
  assert.match(lines[3], /done/);
});

test('normalizeRunOptions: legacy boolean and --debug implies verbose', () => {
  assert.deepEqual(normalizeRunOptions(false), { debug: false, verbose: false });
  assert.deepEqual(normalizeRunOptions(true), { debug: true, verbose: true });
  assert.deepEqual(normalizeRunOptions({ verbose: true }), { debug: false, verbose: true });
  assert.deepEqual(normalizeRunOptions({ debug: true }), { debug: true, verbose: true });
  assert.deepEqual(normalizeRunOptions(undefined), { debug: false, verbose: false });
});

test('spawnValidator: quiet by default, mirrors with verbose, reports phases', async () => {
  const written = [];
  const phases = [];
  const quiet = await spawnValidator(['-jar', 'x.jar'], {
    spawnFn: fakeSpawn({ output: SAMPLE_OUTPUT, code: 1 }),
    write: (t) => written.push(t),
    onPhase: (p) => phases.push(p),
  });
  assert.equal(quiet.code, 1);
  assert.equal(quiet.rawOutput, SAMPLE_OUTPUT);
  assert.deepEqual(written, []);
  assert.ok(phases.includes('Validating'));

  const verbose = await spawnValidator(['-jar', 'x.jar'], {
    verbose: true,
    spawnFn: fakeSpawn({ output: SAMPLE_OUTPUT }),
    write: (t) => written.push(t),
  });
  assert.equal(written.join(''), SAMPLE_OUTPUT);
  assert.equal(verbose.rawOutput, SAMPLE_OUTPUT);

  await assert.rejects(
    spawnValidator(['-jar', 'x.jar'], { spawnFn: fakeSpawn({ startError: new Error('ENOENT') }) }),
    /Could not start Java for the FHIR validator: ENOENT/,
  );
});

const hasSummary = (out) => !!parseValidatorOutput(out).summary;

test('executeValidator: concise progress, always writes the raw log', async () => {
  const stream = recorder();
  const logPath = path.join(TMP, 'ok', 'Patient-modified-raw.log');
  const res = await executeValidator({
    args: ['-jar', 'x.jar'],
    logPath,
    hasResult: hasSummary,
    stream,
    spawnFn: fakeSpawn({ output: SAMPLE_OUTPUT, code: 1 }),
  });
  assert.equal(res.logPath, logPath);
  assert.equal(fs.readFileSync(logPath, 'utf8'), SAMPLE_OUTPUT, 'log file contains the raw output');
  const text = stream.text();
  assert.ok(!text.includes('Information @'), 'raw output not mirrored');
  assert.match(text, /HL7 FHIR Validator finished: \*FAILURE\*: 34 errors, 1 warnings, 101 notes/);
  assert.match(text, /Done\. Times:/);
  assert.ok(text.includes(logPath));
  assert.ok(text.split('\n').length < 15, `output stays short:\n${text}`);
});

test('executeValidator: --verbose streams the full output', async () => {
  const stream = recorder();
  await executeValidator({
    args: [],
    logPath: path.join(TMP, 'verbose', 'x-raw.log'),
    hasResult: hasSummary,
    verbose: true,
    stream,
    spawnFn: fakeSpawn({ output: SAMPLE_OUTPUT }),
  });
  assert.equal((stream.text().match(/Information @/g) || []).length, 30);
});

test('executeValidator: crash without summary rejects with tail and log path', async () => {
  const stream = recorder();
  const logPath = path.join(TMP, 'crash', 'x-raw.log');
  const crash = 'Loading\n  Load FHIR v4.0.1\nException in thread "main" java.lang.OutOfMemoryError: Java heap space\n\tat org.hl7.Foo.bar(Foo.java:1)\n';
  await assert.rejects(
    executeValidator({ args: [], logPath, hasResult: hasSummary, stream, spawnFn: fakeSpawn({ output: crash, code: 1 }) }),
    (err) => {
      assert.match(err.message, /exited with code 1 and produced no result summary/);
      assert.match(err.message, /OutOfMemoryError: Java heap space/);
      assert.ok(err.message.includes(`Full validator output: ${logPath}`));
      assert.equal(err.shortMessage, `FHIR Java Validator produced no result summary (exit code 1). Full validator output: ${logPath}`);
      assert.equal(err.exitCode, 1);
      assert.equal(err.logPath, logPath);
      return true;
    },
  );
  assert.equal(fs.readFileSync(logPath, 'utf8'), crash);
  assert.match(stream.text(), /HL7 FHIR Validator failed \(exit code 1, no result summary\)/);
});
