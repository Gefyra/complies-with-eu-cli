#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Command, CommanderError } = require('commander');
const chalk = require('chalk');
const { getPackageInfo } = require('../src/lib/config');
const { CliError, EXIT } = require('../src/lib/errors');

const { version } = getPackageInfo();

const PACKAGE_ARG_HELP = "FHIR package as 'name[@version|#version]' (default version: current)";

const GLOBAL_HELP = `
Getting started:
  1. complies-with-eu init        one-time: downloads the HL7 FHIR validator, fhir-pkg-tool
                                  and the EU packages (needs Java 21+)
  2. complies-with-eu validate hl7.fhir.uv.ips@2.0.0 \\
       http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips --all-counterparts
  3. Open the Markdown report printed at the end of the run.
  Check your setup with: complies-with-eu doctor

Reports:
  Written to <workdir>/<profile>-report.md (package mode: <workdir>/<package>/).
  Default workdir: ~/.complies-with-eu/workdir (override: --workdir or COMPLIES_WITH_EU_WORKDIR).

Exit codes:
  0  success (also when profiles are non-compliant, unless --fail-on-noncompliant is set)
  1  at least one selected EU profile is not fulfilled (only with --fail-on-noncompliant)
  2  usage or operational error (Java missing, not initialised, package not found, validator crash)

Environment variables:
  COMPLIES_WITH_EU_HOME                 state directory (default ~/.complies-with-eu: tools/, workdir/, cache.json)
  COMPLIES_WITH_EU_WORKDIR              reports and intermediate files (default <home>/workdir)
  COMPLIES_WITH_EU_VALIDATOR_VERSION    override the pinned HL7 validator version ("latest" or a tag; not checksum-verified)
  COMPLIES_WITH_EU_FHIR_PKG_TOOL_VERSION override the pinned fhir-pkg-tool version (not checksum-verified)
  VALIDATOR_SERVER_PORT                 port of the local validator server in package mode
  JAVA_HOME                             Java installation to use (otherwise "java" on PATH)
  GITHUB_TOKEN                          sent to GitHub when downloading tools (avoids rate limits)
  DEBUG                                 print stack traces on errors
`;

function buildProgram() {
  const program = new Command();

  program
    .name('complies-with-eu')
    .description('Checks whether a FHIR profile complies with the HL7 Europe profiles, using the compliesWithProfile extension and the HL7 FHIR validator')
    .version(version, '-V, --version', 'Print the version')
    .addHelpText('after', GLOBAL_HELP)
    .showHelpAfterError('(run with --help for usage)')
    .exitOverride();

  program
    .command('init')
    .description('Download the pinned fhir-pkg-tool and HL7 FHIR validator (see tools.json) and all EU packages')
    .option('--force', 'Force re-download of the tools even if already present')
    .action((options) => require('../src/commands/init').runInit(options));

  program
    .command('doctor')
    .description('Check the environment: Node.js, Java, installed tools, EU packages and paths')
    .option('--json', 'Output the diagnostics as JSON')
    .option('--workdir <dir>', 'Workdir to report (default: $COMPLIES_WITH_EU_WORKDIR or <home>/workdir)')
    .action((options) => require('../src/commands/doctor').runDoctor(options));

  program
    .command('validate <package> <canonical>')
    .description(`Validate one FHIR profile against EU profiles. <package>: ${PACKAGE_ARG_HELP}`)
    .option('--eu-profiles <profiles>', 'Comma-separated EU profile canonical URLs (skips interactive selection)')
    .option('--all-counterparts', 'Use all EU profiles of the same resource type (no prompt)')
    .option('--examples', 'Also validate all example instances of the matching FHIR type in the package')
    .option('--json', 'Output result as JSON on stdout (machine-readable, for CI use; progress goes to stderr)')
    .option('--output <file>', 'Write JSON output to file instead of stdout (requires --json)')
    .option('--fail-on-noncompliant', 'Exit with code 1 if a selected EU profile is not fulfilled')
    .option('--workdir <dir>', 'Directory for reports and intermediate files (default: <home>/workdir)')
    .option('--debug', 'Print the full Java validator command, keep the raw output and show stack traces')
    .addHelpText('after', `
Examples:
  $ complies-with-eu validate hl7.fhir.uv.ips@2.0.0 http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips --all-counterparts
  $ complies-with-eu validate hl7.fhir.uv.ips@2.0.0 http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips \\
      --eu-profiles http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core --json --output result.json

Without --eu-profiles or --all-counterparts an interactive selection is shown;
without a terminal (CI, --json) one of the two flags is required.`)
    .action((pkg, canonical, options) => require('../src/commands/validate').runValidate(pkg, canonical, options));

  program
    .command('validate-batch <jsonFileOrPackage>')
    .description(
      'Validate profiles in batch mode.\n' +
      '  - If the argument is an existing .json file: todo-file mode (array of { package, version, profiles[] }),\n' +
      '    all EU profiles of the matching type are used.\n' +
      "  - Otherwise: package mode ('name[@version|#version]'): validates all profiles in the package that have EU counterparts."
    )
    .option('--examples', 'Also validate all example instances of the matching FHIR types')
    .option('--json', 'Output result as JSON on stdout (machine-readable, for CI use; progress goes to stderr)')
    .option('--output <file>', 'Write JSON output to file instead of stdout (requires --json)')
    .option('--fail-on-noncompliant', 'Exit with code 1 if a selected EU profile is not fulfilled (2 if a profile could not be validated)')
    .option('--workdir <dir>', 'Directory for reports and intermediate files (default: <home>/workdir)')
    .option('--mapping <file>', 'Package mode: load EU counterpart mapping from external JSON file (skips prompts)')
    .option('--all-counterparts', 'Package mode: use all matching EU profiles of the same type (no prompts)')
    .option('--reselect', 'Package mode: force re-prompting even if mapping.json exists')
    .option('--type <types>', 'Package mode: comma-separated resource types to filter (e.g. Patient,Observation)')
    .option('--server-port <port>', 'Package mode: port for the local Java validator server (default: a free port; also $VALIDATOR_SERVER_PORT). A server already running there is reused only if it has the package loaded')
    .option('--debug', 'Print the full Java validator command, keep the raw output and show stack traces')
    .action((arg, options) => {
      const { runValidateBatchFile, runValidatePackage } = require('../src/commands/validate');
      if (arg.endsWith('.json') && fs.existsSync(arg)) {
        return runValidateBatchFile(arg, options);
      }
      return runValidatePackage(arg, options);
    });

  program
    .command('search <packageOrCanonical>')
    .description(
      'Interactive: list all profiles in a package that have EU counterparts, then validate the selected one. ' +
      `Package format: ${PACKAGE_ARG_HELP}. ` +
      'If a canonical URL (http/https) is given instead, Simplifier.net is queried to find ' +
      'packages containing that canonical and you can pick one to validate.'
    )
    .option('--type <types>', 'Comma-separated resource types to filter (e.g. Patient,Condition)')
    .option('--eu-profiles <profiles>', 'Passed to validate: comma-separated EU profile canonical URLs')
    .option('--all-counterparts', 'Passed to validate: use all EU profiles of the same type')
    .option('--examples', 'Passed to validate: also validate example instances')
    .option('--json', 'Passed to validate: machine-readable output')
    .option('--output <file>', 'Passed to validate: write JSON output to file (requires --json)')
    .option('--fail-on-noncompliant', 'Passed to validate: exit with code 1 if a selected EU profile is not fulfilled')
    .option('--workdir <dir>', 'Directory for reports and intermediate files (default: <home>/workdir)')
    .option('--debug', 'Passed to validate: debug output and stack traces')
    .action((pkg, options) => require('../src/commands/search').runSearch(pkg, options));

  program
    .command('build-index')
    .description('Scan all EU packages and output a JSON index of StructureDefinitions (used to generate eu-profiles.json)')
    .option('--output <file>', 'Write output to a file instead of stdout')
    .action((options) => require('../src/commands/buildIndex').runBuildIndex(options));

  program
    .command('clean')
    .description('Remove workdir artifacts (modified JSONs, logs) but keep Markdown reports and mapping.json')
    .option('--workdir <dir>', 'Workdir to clean (default: $COMPLIES_WITH_EU_WORKDIR or <home>/workdir)')
    .action((options) => require('../src/commands/clean').runClean(options));

  return program;
}

function wantsStack(argv) {
  return argv.includes('--debug') || !!process.env.DEBUG;
}

async function main(argv = process.argv) {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and --version end with exit code 0; commander already printed usage errors.
      process.exitCode = err.exitCode === 0 ? EXIT.OK : EXIT.ERROR;
      return;
    }
    const message = err instanceof CliError ? err.message : `Unexpected error: ${err && err.message ? err.message : err}`;
    process.stderr.write(chalk.red(`\nError: ${message}\n`));
    if (wantsStack(argv) && err && err.stack) process.stderr.write(chalk.gray(`${err.stack}\n`));
    process.exitCode = err instanceof CliError ? err.exitCode : EXIT.ERROR;
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildProgram, main };
