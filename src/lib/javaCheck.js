'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { CliError } = require('./errors');

const INSTALL_HINT = 'Install a current JDK/JRE, e.g. Eclipse Temurin: https://adoptium.net';

/**
 * Minimum Java major version needed by the pinned tools.
 * fhir-pkg-tool is compiled for Java 21 (class file version 65); the HL7 FHIR
 * validator needs Java 17. The maximum over tools.json "minJava" wins.
 */
function requiredJavaMajor(toolsManifest) {
  let max = 17;
  for (const tool of Object.values(toolsManifest || {})) {
    if (tool && Number.isInteger(tool.minJava) && tool.minJava > max) max = tool.minJava;
  }
  return max;
}

/**
 * Returns the java executable to use: $JAVA_HOME/bin/java if it exists, otherwise
 * "java" from PATH.
 *
 * @param {object}   [env=process.env]
 * @param {Function} [exists] - (absPath) => boolean
 * @param {string}   [platform=process.platform]
 * @returns {{ command: string, source: 'JAVA_HOME'|'PATH' }}
 */
function resolveJavaCommand(env = process.env, exists = fs.existsSync, platform = process.platform) {
  const javaHome = env.JAVA_HOME && env.JAVA_HOME.trim();
  if (javaHome) {
    const bin = path.join(javaHome, 'bin', platform === 'win32' ? 'java.exe' : 'java');
    if (exists(bin)) return { command: bin, source: 'JAVA_HOME' };
  }
  return { command: 'java', source: 'PATH' };
}

/**
 * Parses the major version from `java -version` output.
 * Handles: 'version "1.8.0_402"' (→ 8), 'version "17.0.10"' (→ 17), 'version "21"' (→ 21),
 * and the `java --version` style 'openjdk 21.0.2 2024-01-16' (→ 21).
 *
 * @param {string} text
 * @returns {number|null}
 */
function parseJavaMajorVersion(text) {
  if (!text) return null;
  const quoted = String(text).match(/version\s+"([^"]+)"/i);
  const raw = quoted ? quoted[1] : (String(text).match(/^(?:openjdk|java)\s+(\d[\w.+-]*)/im) || [])[1];
  if (!raw) return null;
  const parts = raw.split(/[.+_-]/);
  let major = parseInt(parts[0], 10);
  if (major === 1 && parts.length > 1) major = parseInt(parts[1], 10);
  return Number.isFinite(major) ? major : null;
}

/**
 * Runs `java -version` and reports what it found. Never throws.
 *
 * @returns {{ found: boolean, command: string, source: string, major: number|null, versionLine: string|null, error: string|null }}
 */
function detectJava(env = process.env) {
  const { command, source } = resolveJavaCommand(env);
  const res = spawnSync(command, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (res.error) {
    return { found: false, command, source, major: null, versionLine: null, error: res.error.message };
  }
  const output = `${res.stderr || ''}\n${res.stdout || ''}`;
  const versionLine = output.split(/\r?\n/).find(l => /version/i.test(l)) || output.trim().split(/\r?\n/)[0] || null;
  return { found: true, command, source, major: parseJavaMajorVersion(output), versionLine, error: null };
}

/**
 * Throws a CliError with an actionable message if Java is missing or too old.
 * An unparseable version only produces a warning (some vendors print unusual banners).
 *
 * @param {number} minMajor
 * @param {object} [opts]
 * @param {Function} [opts.warn] - Called with a warning message
 * @returns {ReturnType<typeof detectJava>}
 */
function ensureJava(minMajor, { warn = (m) => process.stderr.write(m + '\n') } = {}) {
  const info = detectJava();
  if (!info.found) {
    throw new CliError(
      `Java not found (tried ${info.source === 'JAVA_HOME' ? '$JAVA_HOME/bin/java' : '"java" on PATH'}: ${info.error}).\n` +
      `complies-with-eu needs Java ${minMajor} or newer on PATH or in JAVA_HOME.\n` +
      INSTALL_HINT
    );
  }
  if (info.major === null) {
    warn(`Warning: could not determine the Java version of ${info.command} (${info.versionLine || 'no output'}). Java ${minMajor}+ is required.`);
    return info;
  }
  if (info.major < minMajor) {
    throw new CliError(
      `Found Java ${info.major} at ${info.command}, but complies-with-eu needs Java ${minMajor} or newer ` +
      `(fhir-pkg-tool requires Java 21, the HL7 FHIR validator Java 17).\n` +
      `Install a newer Java and put it on PATH or point JAVA_HOME to it.\n` +
      INSTALL_HINT
    );
  }
  return info;
}

/** The java command used for all child processes. */
function getJavaCommand() {
  return resolveJavaCommand().command;
}

module.exports = {
  INSTALL_HINT,
  requiredJavaMajor,
  resolveJavaCommand,
  parseJavaMajorVersion,
  detectJava,
  ensureJava,
  getJavaCommand,
};
