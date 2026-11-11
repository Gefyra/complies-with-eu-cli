'use strict';

const chalk = require('chalk');
const ora = require('ora');
const fs = require('fs-extra');
const {
  getHomeToolsDir,
  getLegacyToolsDir,
  loadEuPackages,
  loadToolsManifest,
  getWorkdir,
} = require('../lib/config');
const { ensureTool } = require('../lib/toolDownloader');
const { downloadFhirPackages } = require('../lib/fhirPkgTool');
const { ensureJava, requiredJavaMajor } = require('../lib/javaCheck');
const { CliError } = require('../lib/errors');

const log = (...args) => process.stderr.write(args.join(' ') + '\n');

async function runInit(options = {}) {
  const force = !!options.force;
  const manifest = loadToolsManifest();

  console.log(chalk.bold('\ncomplies-with-eu init\n'));

  // 0. Java first: no point in downloading ~350 MB of JARs without a usable Java
  const java = ensureJava(requiredJavaMajor(manifest), { warn: (m) => log(chalk.yellow(m)) });
  console.log(chalk.gray(`  Java ${java.major ?? '?'} (${java.command})`));

  // 1. Tools directory (<home>/tools, $COMPLIES_WITH_EU_HOME overrides the home)
  const toolsDir = getHomeToolsDir();
  await fs.ensureDir(toolsDir);
  console.log(chalk.gray(`  Tools directory: ${toolsDir}\n`));

  // 2. Download the pinned JARs (checksum-verified)
  for (const key of ['fhirPkgTool', 'validator']) {
    const tool = manifest[key];
    const spinner = ora(`Installing ${tool.name} ${tool.version}...`).start();
    try {
      const res = await ensureTool(tool, {
        toolsDir,
        force,
        legacyDir: getLegacyToolsDir(),
        log: (m) => { spinner.text = m; },
        warn: (m) => { spinner.warn(m); spinner.start(); },
      });
      const how = { present: 'already installed', adopted: 'already installed, checksum verified', copied: 'copied from the legacy .tools directory', downloaded: 'downloaded' }[res.action];
      spinner.succeed(`${tool.name} ${res.version} (${how})`);
    } catch (err) {
      spinner.fail(`${tool.name}: ${err.message}`);
      throw new CliError(err.message);
    }
  }

  // 3. Download all EU packages via fhir-pkg-tool
  const euPackages = loadEuPackages();
  console.log(chalk.cyan(`\nDownloading ${euPackages.length} EU FHIR packages...`));

  const spinner3 = ora('Running fhir-pkg-tool for EU packages...').start();
  try {
    await downloadFhirPackages(euPackages);
    spinner3.succeed(`All ${euPackages.length} EU packages downloaded`);
  } catch (err) {
    spinner3.fail(`Failed to download EU packages: ${err.message}`);
    throw new CliError(`Failed to download EU packages: ${err.message}`);
  }

  console.log(chalk.green('\nInitialization complete. You can now run:\n'));
  console.log(chalk.white('  complies-with-eu validate <package[@version]> <canonical>\n'));
  console.log(chalk.gray(`  Reports will be written to: ${getWorkdir()}\n`));
}

module.exports = { runInit };
