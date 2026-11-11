'use strict';

const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const { getWorkdir, setWorkdir } = require('../lib/config');

/** Files that `clean` keeps: Markdown reports and package-mode mapping.json. */
function isKeptFile(filePath) {
  return filePath.endsWith('-report.md') || path.basename(filePath) === 'mapping.json';
}

/**
 * Recursively collects all files under a directory.
 * @param {string} dir
 * @returns {Promise<string[]>} absolute file paths
 */
async function collectFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Removes a directory if it is empty (never removes root itself).
 * @param {string} dir
 * @param {string} root - stop recursion here (don't remove root)
 */
async function removeEmptyDirs(dir, root) {
  if (dir === root) return;
  const entries = await fs.readdir(dir);
  if (entries.length === 0) {
    await fs.rmdir(dir);
  }
}

async function runClean(options = {}) {
  if (options.workdir) setWorkdir(options.workdir);
  console.log(chalk.bold('\ncomplies-with-eu clean\n'));

  const workdir = getWorkdir();
  console.log(chalk.gray(`  Workdir: ${workdir}`));
  if (!await fs.pathExists(workdir)) {
    console.log(chalk.gray('  Workdir does not exist, nothing to do.'));
    return;
  }

  const allFiles = await collectFiles(workdir);

  const toDelete = allFiles.filter(f => !isKeptFile(f));
  const kept = allFiles.filter(f => isKeptFile(f));

  if (toDelete.length === 0) {
    console.log(chalk.green('  Nothing to delete, only reports are present.'));
    return;
  }

  let deleted = 0;
  for (const file of toDelete) {
    await fs.remove(file);
    console.log(chalk.gray(`  Deleted: ${path.relative(workdir, file)}`));
    deleted++;
  }

  // Remove empty subdirectories (bottom-up via sorted descending by depth)
  const allDirs = [];
  const collectDirs = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const full = path.join(dir, entry.name);
        allDirs.push(full);
        await collectDirs(full);
      }
    }
  };
  await collectDirs(workdir);
  // Sort deepest first
  allDirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const dir of allDirs) {
    await removeEmptyDirs(dir, workdir);
  }

  console.log('');
  console.log(chalk.green(`  ${deleted} file(s) deleted, ${kept.length} file(s) kept (reports, mapping.json).`));
  console.log(chalk.bold.green('\nDone!\n'));
}

module.exports = { runClean, isKeptFile };
