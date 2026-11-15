import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import axios from 'axios';
import chalk from 'chalk';
import { getValidatorJar, loadValidatorParams } from './config.js';
import { getJavaCommand } from './javaCheck.js';
import { track } from './processRegistry.js';
import { mapSettled } from './javaValidator.js';
import { createOutputHandler, createProgress, formatValidatorError, formatValidatorErrorShort, createValidatorError, tailLines } from './validatorOutput.js';

const DEFAULT_PORT = 7272;
const READY_POLL_INTERVAL_MS = 2500;
// Total budget: port open + lazy IG loading + possible network timeouts on first request
const READY_TIMEOUT_MS = 600_000; // 10 min
const POST_CONCURRENCY = 4;
// In-memory tail of the server output kept for error messages (the full output goes to the log file)
const SERVER_OUTPUT_TAIL_CHARS = 64 * 1024;
// Text of the validator message SD_EXTENSION_COMPLIES_WITH_ERROR
const COMPLIES_WITH_ERROR_TEXT = /does not comply with claimed profile '[^']+'/;

/**
 * Returns true if something answers HTTP on the given port.
 */
async function isServerReady(port) {
  try {
    await axios.get(`http://127.0.0.1:${port}/`, { timeout: 3000 });
    return true;
  } catch (err) {
    if (err.response) return true; // HTTP error = server is up
    return false;
  }
}

/**
 * Asks the OS for a free TCP port on 127.0.0.1.
 * @returns {Promise<number>}
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Checks whether a validator already running on `port` has the given canonical
 * loaded (GET /canonical, available in validator 7.x). Anything else, including
 * an older validator or an unrelated process, returns false.
 */
async function serverHasCanonical(port, canonical) {
  try {
    const res = await axios.get(`http://127.0.0.1:${port}/canonical`, {
      params: { url: canonical },
      timeout: 10_000,
      validateStatus: () => true,
    });
    return res.status === 200 && res.data && res.data.url === canonical;
  } catch {
    return false;
  }
}

/**
 * Phase 1: polls until the port accepts connections.
 * Throws if `isDead()` returns true (process exited).
 */
async function waitForPort(port, deadline, isDead, pollIntervalMs = READY_POLL_INTERVAL_MS) {
  while (Date.now() < deadline) {
    if (isDead()) throw new Error('Validator process exited before the server became ready');
    if (await isServerReady(port)) return;
    await new Promise(r => setTimeout(r, Math.max(0, Math.min(pollIntervalMs, deadline - Date.now()))));
  }
  throw new Error(`Validator server on port ${port} did not start within the timeout`);
}

/**
 * Phase 2: sends a minimal warmup POST to trigger lazy IG loading.
 * The first request often fails with "socket hang up" because the Java validator
 * loads packages lazily and drops the connection if a network lookup times out.
 * We keep retrying until we receive an actual HTTP response.
 */
async function warmupServer(port, deadline, isDead) {
  const warmupResource = { resourceType: 'Patient' };

  while (Date.now() < deadline) {
    if (isDead()) throw new Error('Validator process exited during server warmup');
    try {
      // Allow up to 2 min per attempt — IGs can take a while to load on first request
      const remaining = deadline - Date.now();
      await axios.post(`http://127.0.0.1:${port}/validateResource`, warmupResource, {
        headers: { 'Content-Type': 'application/fhir+json' },
        validateStatus: () => true,
        timeout: Math.min(120_000, remaining),
      });
      return; // Got any HTTP response → server is fully loaded
    } catch {
      // Connection error (socket hang up / ECONNRESET): validator dropped the connection
      // while loading a dependency package whose version it tried to resolve online.
      // Wait briefly and retry — the successfully loaded packages stay cached.
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error(`Validator server on port ${port} did not complete warmup within the timeout`);
}

/**
 * Starts the FHIR Java Validator in server mode with all IGs pre-loaded.
 * Port is passed as the value of the -server flag: java -jar validator_cli.jar -server <port> -ig ...
 * Waits until the server is truly ready (lazy loading complete) before returning.
 * The JVM is killed if startup or warmup fails, and when the CLI exits.
 *
 * The server output is written to `logFile` (when given) and streamed to stderr
 * only with `verbose`/`debug`; otherwise a concise progress indicator is shown.
 * Startup failures include the last lines of server output and the log path.
 *
 * @param {object}   opts
 * @param {string[]} opts.igIds    - IG identifiers (name#version or local path) to pre-load
 * @param {number}  [opts.port]    - Port to listen on (default: a free port chosen by the OS)
 * @param {boolean} [opts.debug]   - Print the full startup command (implies verbose)
 * @param {boolean} [opts.verbose] - Stream the full server output to stderr
 * @param {string}  [opts.logFile] - File that receives the raw server output
 * @param {NodeJS.WritableStream} [opts.stream] - Progress / output sink (default process.stderr)
 * @param {Function} [opts.spawnFn]  - child_process.spawn replacement (tests)
 * @param {string}  [opts.jar]       - validator_cli.jar path (default: the installed one)
 * @param {number}  [opts.readyTimeoutMs] - Startup + warmup budget (default 10 min)
 * @param {number}  [opts.pollIntervalMs] - Port poll interval
 * @param {number}  [opts.startupGraceMs] - Pause that catches immediate start failures
 * @returns {Promise<{ port: number, stop: Function, logFile: string|null,
 *   isDead: Function, exitInfo: Function, getOutput: Function, tail: Function }>}
 *   `isDead()` / `exitInfo()` tell whether (and how) the JVM exited after startup,
 *   `getOutput()` returns the in-memory tail of its output, `tail(n)` its last n lines.
 */
async function startValidatorServer({
  igIds,
  port = null,
  debug = false,
  verbose = false,
  logFile = null,
  stream = process.stderr,
  spawnFn = spawn,
  jar = getValidatorJar(),
  readyTimeoutMs = READY_TIMEOUT_MS,
  pollIntervalMs = READY_POLL_INTERVAL_MS,
  startupGraceMs = 600,
}) {
  if (!await fs.pathExists(jar)) {
    throw new Error(`validator_cli.jar not found at ${jar}. Run: complies-with-eu init`);
  }
  const listenPort = port || await findFreePort();
  const showOutput = debug || verbose;

  const baseParams = loadValidatorParams();
  const igArgs = igIds.flatMap(id => ['-ig', id]);

  const args = [
    '-jar', jar,
    'server', String(listenPort),
    ...igArgs,
    ...baseParams,
  ];

  const write = (text) => stream.write(text);
  if (debug) {
    write(chalk.bold.yellow('\n[DEBUG] Starting validator server:\n'));
    write(chalk.yellow(`${getJavaCommand()} ${args.join(' ')}\n\n`));
  } else {
    write(chalk.gray(`  java -jar validator_cli.jar server ${listenPort} ... (${igIds.length} IGs)\n`));
  }

  let logStream = null;
  if (logFile) {
    await fs.ensureDir(path.dirname(logFile));
    logStream = fs.createWriteStream(logFile, { encoding: 'utf8' });
    logStream.on('error', () => { /* the log is best effort */ });
  }

  const progress = createProgress({ text: 'Starting HL7 FHIR Validator server', verbose: showOutput, stream });
  let starting = true;
  const handler = createOutputHandler({
    verbose: showOutput,
    write: (text) => write(chalk.gray(text)),
    maxChars: SERVER_OUTPUT_TAIL_CHARS,
    onPhase: (label) => { if (starting) progress.phase(label); },
    onChunk: (text) => { if (logStream) logStream.write(text); },
  });

  const proc = track(spawnFn(getJavaCommand(), args, { windowsHide: true }));
  proc.stdout.on('data', handler.onData);
  proc.stderr.on('data', handler.onData);

  let procExited = false;
  let procError = null;
  let exitCode = null;
  let exitSignal = null;
  proc.on('error', err => { procError = err; });
  proc.on('exit', (code, signal) => {
    procExited = true;
    exitCode = code;
    exitSignal = signal || null;
  });
  proc.on('close', () => { if (logStream) logStream.end(); });

  const isDead = () => procExited || !!procError;
  const stop = () => {
    if (!procExited) {
      try { proc.kill(); } catch { /* ignore */ }
    }
  };

  try {
    // Brief pause to catch immediate startup failures (bad jar path, wrong Java, etc.)
    await new Promise(r => setTimeout(r, startupGraceMs));
    if (procError) throw new Error(`Failed to start validator server: ${procError.message}`);

    const deadline = Date.now() + readyTimeoutMs;

    await waitForPort(listenPort, deadline, isDead, pollIntervalMs);
    if (showOutput) {
      write(chalk.gray(`  Validator server accepting connections on port ${listenPort}, warming up...\n`));
    } else {
      progress.phase('Warming up');
    }

    await warmupServer(listenPort, deadline, isDead);
  } catch (err) {
    starting = false;
    stop();
    progress.fail('HL7 FHIR Validator server could not be started');
    if (procError) throw err;
    handler.flush();
    throw createValidatorError({
      subject: 'FHIR Java Validator server',
      reason: `did not become ready (${err.message})`,
      code: procExited ? exitCode : null,
      signal: exitSignal,
      rawOutput: handler.getOutput(),
      logPath: logFile,
    }, { cause: err });
  }

  starting = false;
  progress.succeed(`HL7 FHIR Validator server ready on port ${listenPort}`);
  if (logFile) write(chalk.gray(`  Server output: ${logFile}\n`));
  return {
    port: listenPort,
    stop,
    logFile,
    isDead,
    exitInfo: () => ({
      exited: isDead(),
      code: procExited ? exitCode : null,
      signal: exitSignal,
      error: procError ? procError.message : null,
    }),
    getOutput: () => { handler.flush(); return handler.getOutput(); },
    tail: (n) => tailLines(handler.getOutput(), n),
  };
}

/**
 * Checks the results of a server batch for failed requests and, if there are
 * any, explains them, so that a crashed or hung server is understandable
 * without --verbose. A short grace period lets the JVM exit be noticed when the
 * requests failed because it has just died.
 *
 * @param {object} server - Return value of startValidatorServer, or a reused
 *                          server `{ port, stop }` without process information
 * @param {Array<{error?: string}>} results - validateBatchViaServer results
 * @param {object} [opts]
 * @param {number} [opts.exitGraceMs] - How long to wait for a pending exit
 * @returns {Promise<null|{ failed: number, total: number, dead: boolean, message: string, short: string }>}
 *   null when every request got a result. `message` is the full explanation
 *   (exit code, output tail, log path) for the console; `short` is one line for
 *   per-profile errors, the JSON output and reports.
 */
async function describeBatchFailure(server, results, { exitGraceMs = 1000 } = {}) {
  const total = results.length;
  const failed = results.filter(r => r && r.error).length;
  if (failed === 0) return null;

  const canInspect = typeof server.isDead === 'function';
  if (canInspect && !server.isDead() && exitGraceMs > 0) {
    const until = Date.now() + exitGraceMs;
    while (!server.isDead() && Date.now() < until) await new Promise(r => setTimeout(r, 50));
  }
  const dead = canInspect && server.isDead();
  const info = canInspect ? server.exitInfo() : { code: null, signal: null };
  const logPath = server.logFile || null;

  let reason;
  if (dead) reason = 'did not finish the batch validation';
  else if (failed === total) reason = `returned no result for any of the ${total} profile(s)`;
  else reason = `returned no result for ${failed} of ${total} profile(s)`;

  const message = canInspect
    ? formatValidatorError({
      subject: 'FHIR Java Validator server',
      reason,
      code: info.code,
      signal: info.signal,
      rawOutput: server.getOutput(),
      logPath,
    })
    : `FHIR Java Validator server ${reason}.`;

  const short = formatValidatorErrorShort({
    subject: 'FHIR Java Validator server',
    reason,
    code: dead ? info.code : null,
    signal: dead ? info.signal : null,
    logPath,
  });

  return { failed, total, dead, message, short };
}

/**
 * Translates an HL7 OperationOutcome from the Java validator server into the internal
 * { summary, issues } format used by the rest of the application.
 * Message IDs are extracted from the {MSG_ID} suffix in the diagnostics field.
 */
function parseOperationOutcome(oo) {
  if (!oo || oo.resourceType !== 'OperationOutcome') {
    return { summary: null, issues: [] };
  }

  const issues = (oo.issue || []).map(issue => {
    const rawMsg = issue.diagnostics || issue.details?.text || '';
    const msgIdMatch = rawMsg.match(/\{([^}]+)\}\s*$/);

    // The server puts the message code in details.coding[0].code (FHIR CodeableConcept),
    // while the CLI appends it as {MSG_ID} to the diagnostics string.
    // Newer validators (7.x) may instead use the operationoutcome-message-id extension or
    // omit the id entirely; compliesWithProfile failures are then recognised by their text,
    // otherwise they would silently count as "compliant".
    const extMsgId = (issue.extension || [])
      .find(e => e && typeof e.url === 'string' && e.url.endsWith('/operationoutcome-message-id'));
    const extMsgIdValue = extMsgId ? (extMsgId.valueCode || extMsgId.valueString || null) : null;
    const msgId = issue.details?.coding?.[0]?.code
      || extMsgIdValue
      || (msgIdMatch ? msgIdMatch[1] : null)
      || (COMPLIES_WITH_ERROR_TEXT.test(rawMsg) ? 'SD_EXTENSION_COMPLIES_WITH_ERROR' : null);

    const locationArr = issue.expression || issue.location || [];
    const location = Array.isArray(locationArr) ? (locationArr[0] || '') : '';

    const message = msgIdMatch
      ? rawMsg.slice(0, rawMsg.length - msgIdMatch[0].length).trim()
      : rawMsg.trim();

    const parsed = {
      severity: issue.severity || 'information',
      location,
      line: null,
      col: null,
      message,
      msgId,
      details: [],
    };

    // Mirror the same "because:" splitting used in parseValidatorOutput so that
    // compliesWithProfile error details are populated the same way as in CLI mode.
    if (parsed.message.includes(' because: ')) {
      const becauseIdx = parsed.message.indexOf(' because: ');
      const becauseText = parsed.message.slice(becauseIdx + ' because: '.length);
      parsed.message = parsed.message.slice(0, becauseIdx);
      parsed.details = becauseText
        .split(/(?:, | and )(?=The constraint|Mismatch|slice error:)/i)
        .map(s => s.trim())
        .filter(Boolean);
    }

    return parsed;
  });

  const errors   = issues.filter(i => i.severity === 'error' || i.severity === 'fatal');
  const warnings = issues.filter(i => i.severity === 'warning');
  const notes    = issues.filter(i => i.severity === 'information');

  return {
    summary: {
      result: errors.length > 0 ? 'FAILURE' : 'SUCCESS',
      text: `${errors.length} errors, ${warnings.length} warnings, ${notes.length} notes`,
    },
    issues,
  };
}

/**
 * POSTs a single FHIR resource to the Java validator server's /validateResource endpoint.
 */
async function postToServer(port, resourceJson) {
  const response = await axios.post(
    `http://127.0.0.1:${port}/validateResource`,
    resourceJson,
    {
      headers: { 'Content-Type': 'application/fhir+json' },
      validateStatus: () => true,
      timeout: 120_000,
    }
  );
  return parseOperationOutcome(response.data);
}

/**
 * Validates a single resource file via an already-running Java validator server.
 * Returns the same shape as runValidator: { rawOutput, parsed }.
 */
async function validateViaServer(port, resourcePath) {
  const resourceJson = await fs.readJson(resourcePath);
  const parsed = await postToServer(port, resourceJson);
  return { rawOutput: '', parsed };
}

/**
 * Validates JSON files in a directory via an already-running Java validator server
 * (at most POST_CONCURRENCY requests in parallel). A failed request only fails
 * that file: its result has summary null and an `error` message.
 *
 * @param {number}   port
 * @param {string}   dirPath
 * @param {string[]} [onlyFiles] - Restrict to these file names (default: all *.json)
 * @returns {Promise<{ rawOutput: string, results: Array<{fileName, summary, issues, error?}> }>}
 */
async function validateBatchViaServer(port, dirPath, onlyFiles = null) {
  const files = onlyFiles || (await fs.readdir(dirPath)).filter(f => f.endsWith('.json'));

  const settled = await mapSettled(files, POST_CONCURRENCY, async (fileName) => {
    const resourceJson = await fs.readJson(path.join(dirPath, fileName));
    return postToServer(port, resourceJson);
  });

  const results = settled.map((r, i) => (r.status === 'fulfilled'
    ? { fileName: files[i], summary: r.value.summary, issues: r.value.issues }
    : { fileName: files[i], summary: null, issues: [], error: r.reason.message }));

  return { rawOutput: '', results };
}

export {
  DEFAULT_PORT,
  isServerReady,
  findFreePort,
  serverHasCanonical,
  startValidatorServer,
  parseOperationOutcome,
  validateViaServer,
  validateBatchViaServer,
  describeBatchFailure,
};
