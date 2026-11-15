'use strict';

/**
 * Output streams of the CLI.
 *
 * - Progress (status lines, lists, spinners from ora) always goes to stderr, so
 *   all human progress output shares one stream and keeps its order when stdout
 *   and stderr are captured separately (e.g. Docker logs, CI) or merged.
 * - The final result (e.g. the PASS/FAIL summary and the report path) goes to
 *   stdout, unless --json is set: then stdout carries only the JSON document and
 *   the human result goes to stderr as well.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * chalk decides about colors based on stdout. When stdout is a terminal but
 * stderr is redirected, strip the color codes from stderr lines so log files
 * stay readable. FORCE_COLOR keeps the colors.
 */
function stripColorsForStream(stream, text) {
  if (stream.isTTY || process.env.FORCE_COLOR) return text;
  return text.replace(ANSI_RE, '');
}

/** Returns a console.log-like writer for the given stream (args joined with a space). */
function writerFor(stream) {
  return (...args) => {
    stream.write(stripColorsForStream(stream, args.join(' ')) + '\n');
  };
}

/** Progress logger: always stderr (same stream as the ora spinners). */
function makeProgressLogger() {
  return writerFor(process.stderr);
}

/** Result logger: stdout, or stderr with --json (stdout is reserved for the JSON document). */
function makeResultLogger(options = {}) {
  return options.json ? writerFor(process.stderr) : writerFor(process.stdout);
}

module.exports = { makeProgressLogger, makeResultLogger, stripColorsForStream };
