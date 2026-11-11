'use strict';

const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs-extra');
const chalk = require('chalk');
const { getValidatorJar, loadValidatorParams } = require('./config');
const { getJavaCommand } = require('./javaCheck');
const { track } = require('./processRegistry');

/**
 * Runs `fn` over `items` with at most `limit` concurrent calls and returns
 * Promise.allSettled-style results in input order.
 */
async function mapSettled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Parses the Java Validator console output into structured issues.
 *
 * Expected line formats:
 *   *FAILURE*: 6 errors, 18 warnings, 12 notes
 *   *SUCCESS*: ...
 *     Severity @ Location (line X, colY): Message {MSG_ID}
 *     Severity @ Location: Message {MSG_ID}
 *       sub-detail line
 */
function parseValidatorOutput(output) {
  // Strip ANSI escape codes (e.g. \x1b[0;39m) emitted by the Java validator
  // eslint-disable-next-line no-control-regex
  const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const lines = clean.split(/\r\n|\r|\n/);
  let summary = null;
  const issues = [];
  let currentIssue = null;

  for (const line of lines) {
    // Summary line
    const summaryMatch = line.match(/^\*(FAILURE|SUCCESS)\*:\s*(.+)/);
    if (summaryMatch) {
      summary = { result: summaryMatch[1], text: summaryMatch[2].trim() };
      currentIssue = null;
      continue;
    }

    // Issue line (2 leading spaces): "  Severity @ Location (line X, colY): Message {MSG_ID}"
    const issueMatch = line.match(/^ {2}(\w+)\s+@\s+(.+?)(?:\s+\(line\s+(\d+),\s+col(\d+)\))?:\s+(.+)$/);
    if (issueMatch) {
      const rawMessage = issueMatch[5].trim();
      const msgIdMatch = rawMessage.match(/\{([^}]+)\}\s*$/);
      currentIssue = {
        severity: issueMatch[1].toLowerCase(),
        location: issueMatch[2].trim(),
        line: issueMatch[3] ? parseInt(issueMatch[3]) : null,
        col: issueMatch[4] ? parseInt(issueMatch[4]) : null,
        message: msgIdMatch
          ? rawMessage.slice(0, rawMessage.length - msgIdMatch[0].length).trim()
          : rawMessage,
        // Fall back to the message text when the {MSG_ID} suffix is missing, so a
        // compliesWithProfile failure is never mistaken for an unrelated issue.
        msgId: msgIdMatch
          ? msgIdMatch[1]
          : (/does not comply with claimed profile '[^']+'/.test(rawMessage) ? 'SD_EXTENSION_COMPLIES_WITH_ERROR' : null),
        details: [],
      };
      issues.push(currentIssue);
      continue;
    }

    // Sub-detail line (4+ leading spaces)
    const detailMatch = line.match(/^ {4,}(.+)$/);
    if (detailMatch && currentIssue) {
      currentIssue.details.push(detailMatch[1].trim());
    }
  }

  // Some Java validator versions/configs inline sub-details with "because: …" on the main
  // line rather than as indented sub-lines.  Mirror the server-side because:-splitting so the
  // local path resolves constraints the same way as the server path.
  for (const issue of issues) {
    if (issue.details.length === 0 && issue.message.includes(' because: ')) {
      const becauseIdx = issue.message.indexOf(' because: ');
      const becauseText = issue.message.slice(becauseIdx + ' because: '.length);
      issue.message = issue.message.slice(0, becauseIdx);
      issue.details = becauseText
        .split(/(?:, | and )(?=The constraint|Mismatch|slice error:)/i)
        .map(s => s.trim())
        .filter(Boolean);
    }
  }

  return { summary, issues };
}

/**
 * Parses Java Validator console output for a batch (directory) run.
 * Splits the output into per-file sections using header lines like:
 *   "-- Validating /path/to/file.json --"  or  "Validate /path/to/file.json"
 *
 * @param {string} output - Raw combined stdout+stderr from the validator
 * @returns {Array<{fileName: string, summary: object|null, issues: Array}>}
 */
function parseValidatorOutputBatch(output) {
  // eslint-disable-next-line no-control-regex
  const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const lines = clean.split(/\r\n|\r|\n/);

  // Find section start indices.
  // The FHIR Java Validator uses several header formats depending on version/flags:
  //   "-- Validating /path/file.json --"          (common, with or without trailing --)
  //   "-- Validating /path/file.json (verbose…)"  (with -verbose, extra text after name)
  //   "Validating /path/file.json"                (no leading --)
  //   "-- /path/file.json --"                     (some versions omit "Validating")
  //
  // Newer validators (6.x/7.x) first print one "  Validate <path>.json" line per file while
  // loading, and only later one result block per file headed by "-- <path>.json -------".
  // When such result headers exist they are the only reliable section boundaries;
  // otherwise all issues would be attributed to the last file and the other files would
  // end up without a summary.
  const resultHeaderRe = /^--\s+(.+?\.json)\s+-+\s*$/;
  const collect = (re) => {
    const found = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) found.push({ fileName: path.basename(m[1].trim().replace(/\\/g, '/')), startIdx: i });
    }
    return found;
  };
  let sections = collect(resultHeaderRe);
  if (sections.length === 0) {
    sections = [];
    for (let i = 0; i < lines.length; i++) {
      // Any line containing "Validat[e|ing] <path>.json" – no end-anchor so extra
      // text after the filename (e.g. " against profile X --") is tolerated.
      const m = lines[i].match(/(?:--\s*)?Validat(?:e|ing)\s+(.+?\.json)/i)
        // Fallback: "-- /path/file.json --" without the "Validating" keyword
        || lines[i].match(/^--\s+(.+?\.json)\s*--\s*$/);
      if (m) {
        sections.push({ fileName: path.basename(m[1].trim().replace(/\\/g, '/')), startIdx: i });
      }
    }
  }

  return sections.map(({ fileName, startIdx }, idx) => {
    const endIdx = idx + 1 < sections.length ? sections[idx + 1].startIdx : lines.length;
    const { summary, issues } = parseValidatorOutput(lines.slice(startIdx, endIdx).join('\n'));
    return { fileName, summary, issues };
  });
}

/**
 * Spawns the Java validator and collects its combined output. All child output
 * is mirrored to stderr (never stdout, which is reserved for --json output).
 *
 * @returns {Promise<{ code: number|null, rawOutput: string }>}
 */
function spawnValidator(args) {
  return new Promise((resolve, reject) => {
    const outputChunks = [];
    const proc = track(spawn(getJavaCommand(), args, { windowsHide: true }));
    const onData = (data) => {
      const text = data.toString();
      process.stderr.write(chalk.gray(text));
      outputChunks.push(text);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('close', (code) => resolve({ code, rawOutput: outputChunks.join('') }));
    proc.on('error', (err) => reject(new Error(`Could not start Java for the FHIR validator: ${err.message}`)));
  });
}

async function buildLocalArgs(target, igIds, extraArgs) {
  const jar = getValidatorJar();
  if (!await fs.pathExists(jar)) {
    throw new Error(`validator_cli.jar not found at ${jar}. Run: complies-with-eu init`);
  }
  const igArgs = igIds.flatMap(id => ['-ig', id]);
  return ['-jar', jar, target, ...igArgs, ...loadValidatorParams(), ...extraArgs];
}

function printCommand(args, debug, label, igCount) {
  if (debug) {
    process.stderr.write(chalk.bold.yellow(`\n[DEBUG] Java Validator command${label}:\n`));
    process.stderr.write(chalk.yellow(`${getJavaCommand()} ${args.join(' ')}\n\n`));
  } else {
    process.stderr.write(chalk.gray(`  java -jar validator_cli.jar ${args[2]} ... (${igCount} IGs)\n`));
  }
}

/**
 * Runs the FHIR Java Validator against a resource file.
 * Does NOT use -output / -html-output; parses the console output instead.
 *
 * Rejects when the validator produced no result summary (crash, wrong Java,
 * unknown option, ...): a missing summary must never be read as "no issues".
 *
 * @param {string}   resourceFile - Path to the resource/profile JSON to validate
 * @param {string[]} igIds        - List of name#version identifiers for -ig
 * @param {boolean}  debug        - Print the full command before execution
 * @param {string[]} extraArgs    - Additional arguments appended after base params (e.g. ['-resolve-path', dir])
 * @returns {Promise<{rawOutput: string, parsed: object, mode: 'local'}>}
 */
async function runValidator(resourceFile, igIds, debug = false, extraArgs = []) {

  const args = await buildLocalArgs(resourceFile, igIds, extraArgs);
  printCommand(args, debug, '', igIds.length);

  const { code, rawOutput } = await spawnValidator(args);
  const parsed = parseValidatorOutput(rawOutput);
  const logPath = resourceFile.replace(/\.json$/, '') + '-raw.log';
  if (debug || !parsed.summary) {
    await fs.outputFile(logPath, rawOutput, 'utf8');
    if (debug) process.stderr.write(chalk.bold.yellow(`\n[DEBUG] Raw validator output written to: ${logPath}\n`));
  }
  if (!parsed.summary) {
    throw new Error(
      `FHIR Java Validator exited with code ${code} and produced no result summary. ` +
      `Raw output: ${logPath}`
    );
  }
  return { rawOutput, parsed, mode: 'local' };
}

/**
 * Runs the FHIR Java Validator against an entire directory in one invocation.
 * Parses per-file sections from the combined output.
 *
 * @param {string}   dirPath   - Directory containing the resource files to validate
 * @param {string[]} igIds     - List of name#version identifiers for -ig
 * @param {boolean}  debug     - Print the full command and write raw log
 * @param {string[]} extraArgs - Additional arguments appended after base params
 * @returns {Promise<{rawOutput: string, results: Array<{fileName, summary, issues}>}>}
 */
async function runValidatorBatch(dirPath, igIds, debug = false, extraArgs = []) {

  const args = await buildLocalArgs(dirPath, igIds, extraArgs);
  printCommand(args, debug, ' (batch)', igIds.length);

  const { code, rawOutput } = await spawnValidator(args);
  const results = parseValidatorOutputBatch(rawOutput);
  const logPath = path.join(dirPath, '_batch-raw.log');
  const noResults = !results.some(r => r.summary);
  if (debug || noResults) {
    await fs.outputFile(logPath, rawOutput, 'utf8');
    if (debug) process.stderr.write(chalk.bold.yellow(`\n[DEBUG] Raw validator output written to: ${logPath}\n`));
  }
  if (noResults) {
    throw new Error(`FHIR Java Validator exited with code ${code} and produced no result summary. Raw output: ${logPath}`);
  }
  return { rawOutput, results };
}

module.exports = {
  runValidator,
  runValidatorBatch,
  parseValidatorOutput,
  parseValidatorOutputBatch,
  mapSettled,
};
