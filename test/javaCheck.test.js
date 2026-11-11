'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseJavaMajorVersion, resolveJavaCommand, requiredJavaMajor } = require('../src/lib/javaCheck');

test('parseJavaMajorVersion: legacy, modern and --version formats', () => {
  const cases = [
    ['java version "1.8.0_402"\nJava(TM) SE Runtime Environment', 8],
    ['openjdk version "17.0.10" 2024-01-16\nOpenJDK Runtime Environment Temurin-17.0.10+7', 17],
    ['openjdk version "21" 2023-09-19', 21],
    ['openjdk version "21.0.2" 2024-01-16 LTS', 21],
    ['openjdk 21.0.2 2024-01-16\nOpenJDK Runtime Environment', 21],
    ['java 22.0.1 2024-04-16', 22],
    ['Picked up JAVA_TOOL_OPTIONS: -Xmx1g\nopenjdk version "11.0.22" 2024-01-16', 11],
    ['openjdk version "25-ea" 2025-09-16', 25],
  ];
  for (const [text, expected] of cases) {
    assert.equal(parseJavaMajorVersion(text), expected, text);
  }
});

test('parseJavaMajorVersion: returns null for empty or unknown output', () => {
  assert.equal(parseJavaMajorVersion(''), null);
  assert.equal(parseJavaMajorVersion(null), null);
  assert.equal(parseJavaMajorVersion('command not found'), null);
});

test('resolveJavaCommand: uses JAVA_HOME only when the binary exists', () => {
  const javaHome = path.join('opt', 'jdk-21');
  const linuxBin = path.join(javaHome, 'bin', 'java');
  const winBin = path.join(javaHome, 'bin', 'java.exe');

  assert.deepEqual(resolveJavaCommand({ JAVA_HOME: javaHome }, (p) => p === linuxBin, 'linux'), { command: linuxBin, source: 'JAVA_HOME' });
  assert.deepEqual(resolveJavaCommand({ JAVA_HOME: javaHome }, (p) => p === winBin, 'win32'), { command: winBin, source: 'JAVA_HOME' });
  assert.deepEqual(resolveJavaCommand({ JAVA_HOME: javaHome }, () => false, 'linux'), { command: 'java', source: 'PATH' });
  assert.deepEqual(resolveJavaCommand({}, () => true, 'linux'), { command: 'java', source: 'PATH' });
  assert.deepEqual(resolveJavaCommand({ JAVA_HOME: '  ' }, () => true, 'linux'), { command: 'java', source: 'PATH' });
});

test('requiredJavaMajor: max of minJava over tools, at least 17', () => {
  assert.equal(requiredJavaMajor(undefined), 17);
  assert.equal(requiredJavaMajor({}), 17);
  assert.equal(requiredJavaMajor({ a: { minJava: 11 } }), 17);
  assert.equal(requiredJavaMajor({ a: { minJava: 17 }, b: { minJava: 21 } }), 21);
  assert.equal(requiredJavaMajor({ a: { minJava: '25' } }), 17, 'non-integer minJava is ignored');
  assert.equal(requiredJavaMajor(require('../tools.json')), 21, 'pinned tools need Java 21');
});
