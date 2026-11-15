'use strict';

/**
 * Handling of the HL7 FHIR Validator console output: by default the raw output
 * (hundreds of "Information @ ..." lines) is NOT mirrored to the terminal. It is
 * collected (and written to a log file by the callers) while a concise progress
 * indicator on stderr shows coarse phase hints. With --verbose (or --debug) the
 * raw output is streamed to stderr as before.
 *
 * Everything here is free of Java/child-process dependencies so it can be unit-tested.
 */

const ora = require('ora');
const chalk = require('chalk');

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** Number of trailing output lines included in error messages. */
const TAIL_LINES = 20;

/** Removes ANSI escape codes. */
function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

/**
 * Coarse phases of a validator run, in the order they normally occur. Phase hints
 * only ever move forward, so interleaved lines cannot make the progress flicker.
 */
const PHASES = [
  { label: 'Loading packages', re: /^\s*(?:Loading\b|Load\s|Installing\s|Package Summary)/ },
  { label: 'Connecting to terminology server', re: /^\s*Terminology server\b/ },
  { label: 'Validating', re: /^\s*(?:Validating\b|Validate\s|-- Validating\b|Get set)/ },
];

/**
 * Returns the index into PHASES that a single output line indicates, or -1.
 * @param {string} line
 * @returns {number}
 */
function detectPhase(line) {
  const clean = stripAnsi(line);
  for (let i = PHASES.length - 1; i >= 0; i--) {
    if (PHASES[i].re.test(clean)) return i;
  }
  return -1;
}

/**
 * Extracts the most useful closing information from the raw output: the last
 * "*FAILURE*: ..." or "*SUCCESS*: ..." summary line and the "Done. Times: ..." line.
 * @param {string} rawOutput
 * @returns {{ summaryLine: string|null, doneLine: string|null, summaryCount: number }}
 */
function extractResultInfo(rawOutput) {
  let summaryLine = null;
  let doneLine = null;
  let summaryCount = 0;
  for (const line of stripAnsi(rawOutput).split(/\r\n|\r|\n/)) {
    if (/^\*(FAILURE|SUCCESS)\*:/.test(line)) {
      summaryLine = line.trim();
      summaryCount++;
    } else if (/^\s*Done\. Times:/.test(line)) {
      doneLine = line.trim();
    }
  }
  return { summaryLine, doneLine, summaryCount };
}

/**
 * Returns the last `n` non-empty lines of the output (ANSI codes removed).
 * @param {string} rawOutput
 * @param {number} [n]
 * @returns {string[]}
 */
function tailLines(rawOutput, n = TAIL_LINES) {
  const lines = stripAnsi(rawOutput || '')
    .split(/\r\n|\r|\n/)
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim() !== '');
  return lines.slice(-n);
}

/**
 * Builds an error message for an abnormal validator run that is understandable
 * without --verbose: exit code, the last lines of output and the log file path.
 *
 * @param {object} p
 * @param {string} p.reason      - What went wrong (e.g. "produced no result summary")
 * @param {number|null} [p.code] - Exit code (null: unknown / still running)
 * @param {string|null} [p.signal] - Terminating signal
 * @param {string} [p.rawOutput]
 * @param {string|null} [p.logPath]
 * @param {string} [p.subject]   - Who failed (default "FHIR Java Validator")
 * @param {number} [p.tail]
 * @returns {string}
 */
function formatValidatorError({ reason, code = null, signal = null, rawOutput = '', logPath = null, subject = 'FHIR Java Validator', tail = TAIL_LINES }) {
  let exit = '';
  if (signal) exit = `was terminated by signal ${signal} and `;
  else if (code !== null && code !== undefined) exit = `exited with code ${code} and `;
  const parts = [`${subject} ${exit}${reason}.`];
  const lines = tailLines(rawOutput, tail);
  if (lines.length > 0) {
    parts.push(`Last ${lines.length} line(s) of validator output:\n${lines.map(l => `    ${l}`).join('\n')}`);
  } else {
    parts.push('The validator produced no output.');
  }
  if (logPath) parts.push(`Full validator output: ${logPath}`);
  return parts.join('\n');
}

/**
 * Creates a handler for validator output chunks. It collects the full output,
 * mirrors it to `write` only when `verbose` is set, and reports phase changes
 * (detected line by line, robust against chunks that split lines).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.verbose]   - Mirror every chunk to `write`
 * @param {Function} [opts.write]    - Sink for mirrored output (default: stderr, gray)
 * @param {Function} [opts.onPhase]  - Called with the phase label when the phase advances
 * @param {Function} [opts.onChunk]  - Called with every raw chunk (e.g. to append to a log file)
 * @param {number} [opts.maxChars]   - Keep only (roughly) the last maxChars characters in memory
 *                                     (for long-running processes; the log file has everything)
 * @returns {{ onData: Function, flush: Function, getOutput: Function, getPhase: Function }}
 */
function createOutputHandler({ verbose = false, write, onPhase, onChunk, maxChars = 0 } = {}) {
  const sink = write || ((text) => process.stderr.write(chalk.gray(text)));
  const chunks = [];
  let buffered = 0;
  let partial = '';
  let phaseIdx = -1;

  const handleLine = (line) => {
    const idx = detectPhase(line);
    if (idx > phaseIdx) {
      phaseIdx = idx;
      if (onPhase) onPhase(PHASES[idx].label);
    }
  };

  const onData = (data) => {
    const text = data.toString();
    chunks.push(text);
    buffered += text.length;
    while (maxChars > 0 && buffered > maxChars && chunks.length > 1) {
      buffered -= chunks.shift().length;
    }
    if (onChunk) onChunk(text);
    if (verbose) sink(text);
    const lines = (partial + text).split(/\r\n|\r|\n/);
    partial = lines.pop();
    for (const line of lines) handleLine(line);
  };

  const flush = () => {
    if (partial) handleLine(partial);
    partial = '';
  };

  return {
    onData,
    flush,
    getOutput: () => chunks.join(''),
    getPhase: () => (phaseIdx >= 0 ? PHASES[phaseIdx].label : null),
  };
}

/**
 * Concise progress indicator for a validator run on stderr.
 *
 * - Default, TTY: an ora spinner whose text shows the current phase.
 * - Default, non-TTY (CI, piped stderr): ora prints no frames; phase changes are
 *   written as single lines instead, so the log stays short and readable.
 * - Verbose: no spinner (it would garble the streamed output); start and end are
 *   printed as plain lines.
 *
 * @param {object} opts
 * @param {string} opts.text          - Base text, e.g. "Running HL7 FHIR Validator"
 * @param {boolean} [opts.verbose]
 * @param {NodeJS.WritableStream} [opts.stream] - default process.stderr
 * @param {Function} [opts.createSpinner] - injectable ora factory (tests)
 */
function createProgress({ text, verbose = false, stream = process.stderr, createSpinner } = {}) {
  const write = (s) => stream.write(s);
  if (verbose) {
    write(chalk.cyan(`${text}...\n`));
    return {
      phase() {},
      succeed(msg) { write(chalk.green(`\n✔ ${msg}\n`)); },
      fail(msg) { write(chalk.red(`\n✖ ${msg}\n`)); },
    };
  }

  const spinner = (createSpinner || ((o) => ora(o)))({ text: `${text}...`, stream }).start();
  let lastPhase = null;
  return {
    phase(label) {
      if (!label || label === lastPhase) return;
      lastPhase = label;
      if (spinner.isEnabled) spinner.text = `${text}: ${label}...`;
      else write(chalk.gray(`  ${label}...\n`));
    },
    succeed(msg) { spinner.succeed(msg); },
    fail(msg) { spinner.fail(msg); },
  };
}

module.exports = {
  TAIL_LINES,
  PHASES,
  stripAnsi,
  detectPhase,
  extractResultInfo,
  tailLines,
  formatValidatorError,
  createOutputHandler,
  createProgress,
};
