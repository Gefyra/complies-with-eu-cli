import test from 'node:test';
import assert from 'node:assert/strict';

import { makeProgressLogger, makeResultLogger, stripColorsForStream } from '../src/lib/output.js';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Captures writes to process.stdout/process.stderr while fn runs. */
function capture(fn) {
  const written = { stdout: '', stderr: '' };
  const orig = { stdout: process.stdout.write, stderr: process.stderr.write };
  process.stdout.write = (chunk) => { written.stdout += chunk; return true; };
  process.stderr.write = (chunk) => { written.stderr += chunk; return true; };
  try {
    fn();
  } finally {
    process.stdout.write = orig.stdout;
    process.stderr.write = orig.stderr;
  }
  return { stdout: written.stdout.replace(ANSI_RE, ''), stderr: written.stderr.replace(ANSI_RE, '') };
}

test('progress logger always writes to stderr (same stream as the spinners)', () => {
  const w = capture(() => {
    const log = makeProgressLogger();
    log('a', 'b');
    log('');
  });
  assert.equal(w.stdout, '');
  assert.equal(w.stderr, 'a b\n\n');
});

test('result logger writes to stdout, or to stderr with --json', () => {
  const plain = capture(() => makeResultLogger({})('Done!'));
  assert.equal(plain.stdout, 'Done!\n');
  assert.equal(plain.stderr, '');

  const json = capture(() => makeResultLogger({ json: true })('Done!'));
  assert.equal(json.stdout, '');
  assert.equal(json.stderr, 'Done!\n');
});

test('stripColorsForStream removes colors only for non-terminal streams', (t) => {
  const prev = process.env.FORCE_COLOR;
  delete process.env.FORCE_COLOR;
  t.after(() => {
    if (prev === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = prev;
  });
  const colored = '\x1b[32mok\x1b[39m';
  assert.equal(stripColorsForStream({ isTTY: false }, colored), 'ok');
  assert.equal(stripColorsForStream({ isTTY: true }, colored), colored);
  process.env.FORCE_COLOR = '1';
  assert.equal(stripColorsForStream({ isTTY: false }, colored), colored);
});
