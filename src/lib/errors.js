'use strict';

/** Exit codes of the CLI. */
const EXIT = Object.freeze({
  OK: 0,
  // Only with --fail-on-noncompliant: at least one selected EU profile is not fulfilled.
  NON_COMPLIANT: 1,
  // Usage or operational error (Java missing, package not found, validator crash, ...).
  ERROR: 2,
});

/**
 * An expected, user-facing error. The message is printed without a stack trace
 * (unless --debug / DEBUG is set) and the process exits with `exitCode`.
 */
class CliError extends Error {
  constructor(message, { exitCode = EXIT.ERROR, cause } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    if (cause) this.cause = cause;
  }
}

/**
 * Sets process.exitCode, never lowering an already set non-zero code.
 */
function setExitCode(code) {
  if (!code) return;
  if (!process.exitCode || code > process.exitCode) process.exitCode = code;
}

/**
 * Computes the exit code of a run from its outcome.
 * Default (failOnNoncompliant=false): always 0, the historic behaviour.
 * With failOnNoncompliant: 2 if any profile errored, else 1 if any EU profile failed, else 0.
 *
 * @param {object}  p
 * @param {boolean} p.failOnNoncompliant
 * @param {number}  [p.nonCompliant=0]
 * @param {number}  [p.errored=0]
 */
function outcomeExitCode({ failOnNoncompliant, nonCompliant = 0, errored = 0 }) {
  if (!failOnNoncompliant) return EXIT.OK;
  if (errored > 0) return EXIT.ERROR;
  if (nonCompliant > 0) return EXIT.NON_COMPLIANT;
  return EXIT.OK;
}

module.exports = { EXIT, CliError, setExitCode, outcomeExitCode };
