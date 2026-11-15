'use strict';

// startValidatorServer / describeBatchFailure without Java: spawn is injected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const {
  startValidatorServer,
  validateBatchViaServer,
  describeBatchFailure,
  findFreePort,
} = require('../src/lib/javaValidatorServer');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe-srv-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const FAKE_JAR = path.join(TMP, 'validator_cli.jar');
fs.writeFileSync(FAKE_JAR, '');

const SERVER_OUTPUT = [
  'FHIR Validation tool Version 6.7.4',
  'Loading',
  '  Load hl7.terminology#7.5.0 - 4190 resources (01:07.851)',
  ...Array.from({ length: 30 }, (_, i) => `  Information @ X[${i}]: note ${i}`),
  'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space',
  '',
].join('\n');

const OOM = 'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space\n';

/** Minimal non-TTY writable stream that records what is written. */
function recorder() {
  const chunks = [];
  return { chunks, write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

/**
 * Fake spawn for a long-running server process: emits `output`, then stays
 * alive until kill() or crash() is called.
 */
function aliveSpawn(output = '') {
  const procs = [];
  const fn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.exitCode = null;
    proc.killed = false;
    let exited = false;
    const exit = (code, signal) => {
      if (exited) return;
      exited = true;
      proc.exitCode = code;
      proc.emit('exit', code, signal);
      proc.emit('close', code, signal);
    };
    proc.kill = () => { proc.killed = true; exit(null, 'SIGTERM'); };
    proc.crash = (text, code = 1) => {
      proc.stderr.emit('data', Buffer.from(text));
      exit(code, null);
    };
    setImmediate(() => { if (output) proc.stdout.emit('data', Buffer.from(output)); });
    procs.push(proc);
    return proc;
  };
  fn.procs = procs;
  return fn;
}

/** Waits until `file` has the expected content (the log stream is flushed asynchronously). */
async function readWhenComplete(file, expected, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  let content = '';
  while (Date.now() < until) {
    content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (content === expected) return content;
    await new Promise(r => setTimeout(r, 20));
  }
  return content;
}

const FAST = { readyTimeoutMs: 300, pollIntervalMs: 50, startupGraceMs: 10 };

test('startValidatorServer: quiet by default, writes the log file, startup failure has tail and log path', async () => {
  const stream = recorder();
  const logFile = path.join(TMP, 'quiet', 'validator-server.log');
  const port = await findFreePort(); // nothing listens: the server never becomes ready
  const spawnFn = aliveSpawn(SERVER_OUTPUT);

  await assert.rejects(
    startValidatorServer({ igIds: ['a#1'], port, logFile, stream, spawnFn, jar: FAKE_JAR, ...FAST }),
    (err) => {
      assert.match(err.message, /^FHIR Java Validator server .*did not become ready/);
      assert.match(err.message, /OutOfMemoryError: Java heap space/);
      assert.ok(err.message.includes(`Full validator output: ${logFile}`));
      assert.ok(!err.shortMessage.includes('\n'), 'short form is one line');
      return true;
    },
  );

  assert.equal(spawnFn.procs[0].killed, true, 'JVM is stopped after a failed start');
  const text = stream.text();
  assert.ok(!text.includes('Information @'), `raw output not mirrored:\n${text}`);
  assert.ok(!text.includes('Load hl7.terminology'), 'raw output not mirrored');
  assert.match(text, /could not be started/);
  assert.equal(await readWhenComplete(logFile, SERVER_OUTPUT), SERVER_OUTPUT, 'log file holds the raw output');
});

test('startValidatorServer: --verbose mirrors the server output', async () => {
  const stream = recorder();
  const port = await findFreePort();
  await assert.rejects(startValidatorServer({
    igIds: [], port, verbose: true, stream, spawnFn: aliveSpawn(SERVER_OUTPUT), jar: FAKE_JAR, ...FAST,
  }));
  assert.equal((stream.text().match(/Information @/g) || []).length, 30);
});

test('describeBatchFailure: a server that dies mid-batch is explained with exit code, tail and log path', async () => {
  const OO = JSON.stringify({ resourceType: 'OperationOutcome', issue: [] });
  const spawnFn = aliveSpawn('Loading\n  Load hl7.terminology#7.5.0\n');
  const sockets = new Set();
  let posts = 0;
  const httpServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST') posts++;
      // GET (port check), the warmup POST and the first profile get an answer
      if (req.method !== 'POST' || posts <= 2) {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(OO);
        return;
      }
      // Then the JVM dies: it prints the crash, exits, and its connections are dropped
      spawnFn.procs[0].crash(OOM);
      httpServer.close();
      for (const s of sockets) s.destroy();
    });
  });
  httpServer.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
  const { port } = httpServer.address();

  const logFile = path.join(TMP, 'batch', 'validator-server.log');
  const stream = recorder();
  const server = await startValidatorServer({
    igIds: [], port, logFile, stream, spawnFn, jar: FAKE_JAR, ...FAST, readyTimeoutMs: 5000,
  });
  assert.equal(server.isDead(), false);
  assert.match(stream.text(), /ready on port/);

  const dir = path.join(TMP, 'batch', 'modified');
  fs.mkdirSync(dir, { recursive: true });
  const files = ['A.json', 'B.json', 'C.json'];
  for (const f of files) fs.writeFileSync(path.join(dir, f), JSON.stringify({ resourceType: 'StructureDefinition' }));

  // One file at a time keeps the outcome deterministic: one result, then the crash
  const results = [];
  for (const f of files) results.push(...(await validateBatchViaServer(port, dir, [f])).results);
  assert.equal(results.filter(r => r.error).length, 2, JSON.stringify(results));
  assert.ok(results[0].summary);

  const failure = await describeBatchFailure(server, results, { exitGraceMs: 100 });
  assert.equal(failure.dead, true);
  assert.equal(failure.failed, 2);
  assert.equal(failure.total, 3);
  assert.match(failure.message, /^FHIR Java Validator server exited with code 1 and did not finish the batch validation\./);
  assert.match(failure.message, /OutOfMemoryError: Java heap space/);
  assert.ok(failure.message.includes(`Full validator output: ${logFile}`));
  assert.ok(!failure.short.includes('\n'), 'short form is one line');
  assert.equal(failure.short, `FHIR Java Validator server did not finish the batch validation (exit code 1). Full validator output: ${logFile}`);
  assert.deepEqual(server.exitInfo(), { exited: true, code: 1, signal: null, error: null });
  assert.ok(server.tail(5).some(l => l.includes('OutOfMemoryError')));
  server.stop();
});

test('describeBatchFailure: null without errors; a reused server without process info still gets a message', async () => {
  assert.equal(await describeBatchFailure({ port: 1, stop() {} }, [{ fileName: 'a', summary: {} }]), null);
  const f = await describeBatchFailure({ port: 1, stop() {} }, [{ error: 'socket hang up' }, { error: 'x' }]);
  assert.equal(f.dead, false);
  assert.equal(f.message, 'FHIR Java Validator server returned no result for any of the 2 profile(s).');
  assert.equal(f.short, f.message);
});
