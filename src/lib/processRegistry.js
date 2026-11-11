'use strict';

/**
 * Tracks spawned child processes (JVMs) so they are killed when the CLI exits,
 * is interrupted (Ctrl+C) or terminated. Prevents orphaned validator servers.
 */

const children = new Set();
let handlersInstalled = false;

function killAll() {
  for (const proc of children) {
    try {
      if (proc.exitCode === null && !proc.killed) proc.kill();
    } catch {
      // ignore
    }
  }
  children.clear();
}

function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.once('exit', killAll);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.once(signal, () => {
        killAll();
        // Conventional exit code for termination by signal
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
    } catch {
      // Some signals are not supported on every platform (e.g. SIGHUP on Windows)
    }
  }
}

/**
 * Registers a child process; it is removed automatically when it exits.
 * @param {import('child_process').ChildProcess} proc
 * @returns {import('child_process').ChildProcess}
 */
function track(proc) {
  installHandlers();
  children.add(proc);
  proc.once('exit', () => children.delete(proc));
  proc.once('error', () => children.delete(proc));
  return proc;
}

module.exports = { track, killAll };
