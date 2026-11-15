# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Piping the output into a program that stops reading early (for example `cwe --help | head -3`) no longer crashes with an unhandled `EPIPE` stack trace; the CLI ends quietly.

## [2.0.0] - 2026-11-15

### Migration notes

- **Node.js:** 22.22.2+ (22.x), 24.15.0+ (24.x) or 26+ is required. Node.js 20, 23 and 25 are no longer supported; `doctor` reports an unsupported version.
- **Verdicts can change from FAIL to PASS:** missing optional EU type slices whose type the profile does not allow are no longer counted as non-compliance (see Changed). They are listed in their own report section.
- **Ctrl+C in a prompt** prints `Cancelled.` and exits with code `130` (1.3.x ended silently).
- **Unchanged:** commands, options, the `--json` shape (with `--html`, the new optional fields `htmlReportPath` / `packageHtmlReportPath` are added), exit codes 0/1/2, report locations. `complies-with-eu` keeps working; `cwe` is an additional alias.

### Added

- Short command alias `cwe`: the package now installs `cwe` next to `complies-with-eu`; both run the same CLI (for example `cwe validate …`, `cwe doctor`).
- `--html` for `validate`, `validate-batch` (both modes) and `search` (passed through to `validate`): writes a self-contained HTML report `<slug>-report.html` next to the Markdown report, and in package mode also `package-report.html` with an overview of all profiles, their EU counterparts and verdicts and relative links to the profile reports. The report has a verdict banner, summary tiles and one card per EU profile with PASS / FAIL badge and findings; optional EU type slices that do not apply are shown on the card as information. With `--examples`, the example results are added to the same HTML page as an "Examples" section (the examples report itself stays Markdown). It works offline and without JavaScript, supports light and dark mode and prints with all sections expanded. Error reports are written as HTML too. The HTML path is printed at the end of the run; with `--json` it is added as the new optional fields `htmlReportPath` (and `packageHtmlReportPath` in package mode). Existing fields are unchanged.
- `clean` keeps `*-report.html` files like `*-report.md`.

### Changed

- **Breaking:** Node.js 22.22.2 or a newer 22.x, 24.15.0 or a newer 24.x, or Node.js 26 and later is required (`engines.node` is `^22.22.2 || ^24.15.0 || >=26.0.0`, the range that inquirer 14 and its `@inquirer/*` packages support). Node.js 20, 23 and 25 are no longer supported. `doctor` reports an unsupported Node.js version as a problem.
- Pressing Ctrl+C in an interactive prompt (EU profile selection in `validate`, the pickers of `search`, the mapping prompts of `validate-batch`) now prints `Cancelled.` on stderr and exits with code `130`. Exit code `130` is documented in the README and in `--help`.
- Missing optional EU type slices no longer fail a profile when the profile does not allow the type at all (for example `Observation.value[x]:valueBoolean` when only Quantity, CodeableConcept, string, Range and Ratio are allowed). The validator reports these as "no slice found for the discriminator type:$this"; restricting the allowed types is a permitted narrowing. They are listed in a new report section "Optional EU type slices not allowed in this profile". Required slices (min ≥ 1), a derived element that is looser than the EU element, other discriminators and runs with snapshot generation errors still fail.
- Clearer errors when a package cannot be found or downloaded. `search`, `validate` and `validate-batch` reject an argument that is neither a FHIR package id (at least two dot-separated parts, e.g. `de.gematik.isik@5.1.1`) nor, for `search`, a canonical URL, and explain what is expected (for example `cwe search ISiKPatient`). The output of fhir-pkg-tool is no longer streamed into the progress output; it is written to `~/.complies-with-eu/logs/fhir-pkg-tool.log`. On failure a short message names the cause (package not found in the registry, registry not reachable) without Java stack traces and points to the log. `--verbose` (now also on `init`) streams the tool output as before.
- The CLI is now an ES module package (`"type": "module"`). Commands, options, exit codes, the `--json` output, report formats and file locations are unchanged.
- The Markdown reports are now rendered from a shared report model that the HTML report uses as well. Their content is unchanged apart from the new type-slice section.
- Updated dependencies: chalk 4 → 6, ora 5 → 10, inquirer 8 → 14, commander 14 → 15. These versions are ESM-only and are now used directly.

## [1.3.1] - 2026-11-15

### Fixed

- Profiles that validate without any error were reported as an operational error ("produced no result summary", exit code 2) instead of PASS. HL7 FHIR Validator 7.x prints the success summary as `Success: …` without asterisks, which the output parser did not recognise. Package mode (`validate-batch <package>`) was not affected.

## [1.3.0] - 2026-11-15

### Added

- `--verbose` for `validate`, `validate-batch` and `search` (passed through to `validate`): streams the full HL7 FHIR Validator output to stderr, as before. `--debug` implies `--verbose`.

### Changed

- The HL7 FHIR Validator output (often several hundred "Information @ …" lines per run) is no longer streamed to stderr by default. A progress indicator shows the current phase (loading packages, validating) and ends with the validator summary, for example `*FAILURE*: 34 errors, 1 warnings, 101 notes`. Without a terminal (CI, piped stderr) each phase is printed once as a plain line. The validator server in package mode is quiet in the same way.
- The raw validator output is now always written to a log file in the workdir (`*-raw.log`, `examples/<slug>/_batch-raw.log`, `<package>/validator-server.log`), not only with `--debug` or on failure. Its path is printed after each run. `clean` removes these logs.
- When the validator crashes, exits abnormally or returns no result summary, the error message now includes the exit code, the last 20 lines of validator output and the path of the log file. In todo-file mode the error is also printed on the console, not only written to the error report.
- Updated dependencies: commander 12 → 14, axios 1.21.1, fs-extra 11.4.1. With commander 14, unexpected extra arguments are rejected with a usage error (exit code 2) instead of being ignored, for example `complies-with-eu doctor extra`.
- README: the disk space requirement is now about 2 GB instead of 1 GB, based on a measured clean installation.

### Fixed

- Package mode: when the validator server crashes or stops answering during the batch (for example out of memory), the progress no longer reports "Validator batch completed". It reports the failure, prints the server exit code, the last lines of its output and the path of `validator-server.log`, and each affected profile error names the log file instead of only `ECONNREFUSED` or `socket hang up`.
- Package mode starts the HL7 FHIR Validator with the `server` command instead of the deprecated `-server` option, which removes the warning "The option '-server' is no longer in use".
- Compliance report: identical rows in the "Non-Compliant Profiles — Details" table (for example the same missing constraint reported for several elements) are collapsed into one row with "(reported N×)". For a missing constraint, the element path is now shown when exactly one element of the EU profile declares that constraint. The `report` field of `--json` contains the same Markdown; the JSON shape is unchanged.
- Progress output no longer appears out of order when stdout and stderr are redirected or captured separately (for example in Docker or CI): all progress lines of `validate`, `validate-batch` and `search` now go to stderr, the same stream as the spinners. The final result (the "Done!" PASS/FAIL list, the report path and the batch summaries) stays on stdout; with `--json` it goes to stderr as before. When stderr is not a terminal, color codes are removed from these progress lines (unless `FORCE_COLOR` is set); spinner symbols and messages from the validator and package tools may still contain color codes.

## [1.2.0]

First public release as `@gefyra/complies-with-eu` under the Apache License 2.0.

### Migration notes

- **State directory.** Tools, the working directory and the cache now live in `~/.complies-with-eu` (`tools/`, `workdir/`, `cache.json`) instead of the installation directory. Override with `COMPLIES_WITH_EU_HOME` and `COMPLIES_WITH_EU_WORKDIR`. A complete legacy `.tools/` folder is still used until the new location is complete, the legacy cache file is merged on the next save, and `init` copies checksum-matching jars from the legacy folder. Reports are now written to `~/.complies-with-eu/workdir` by default (`--workdir` overrides it). Update CI cache paths to `~/.complies-with-eu/tools`.
- **Exit codes.** Operational errors (invalid arguments, Java missing, not initialised, package or profile not found, validator crash) now exit with `2` instead of `1`. Exit code `1` is reserved for non-compliance with `--fail-on-noncompliant`. Non-compliant results still exit with `0` by default, so pipelines that only check for a non-zero exit code are not affected.
- **Remote validation removed.** The options `--validator-server` / `--validator-token` and the environment variables `COMPLIES_WITH_EU_VALIDATOR_SERVER` / `COMPLIES_WITH_EU_VALIDATOR_TOKEN` are gone; validation always runs with the local HL7 FHIR Validator. The environment variables are ignored if still set.

### Added

- `--fail-on-noncompliant` for `validate` and package mode: exit with `1` if a selected EU profile is not fulfilled (opt-in).
- `doctor` command that checks Node.js, Java, tools, EU packages, and paths.
- `tools.json` pins the HL7 FHIR Validator and fhir-pkg-tool versions; downloads are verified against SHA-256 checksums.
- `COMPLIES_WITH_EU_HOME` and `COMPLIES_WITH_EU_WORKDIR` environment variables.
- Licensing and community files: `LICENSE` (Apache-2.0), `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and pull request templates, and Dependabot configuration.
- Unit tests, ESLint, a CI workflow and an npm release workflow.

### Changed

- Per-user state directory and exit code `2` for operational errors (see the migration notes).
- EU packages are pinned to published releases in `eu-packages.json`.
- Other CLI usability improvements. Existing commands, flags, the default exit code and the JSON output stay backward compatible (fields were only added).
- Node.js 20 or newer is required.

### Fixed

- No silent "pass" anymore: a validator run without a result summary (crash, too old Java, empty output) is reported as an error.
- compliesWithProfile failures are recognised even when HL7 Validator 7.x omits the message ID. Before, such failures were counted as compliant.
- Example validation attributed all issues to the last example file with validator 6.x/7.x.
- `--json` writes only JSON to stdout; `--json --examples` now includes the example results.
- Constraint auto-resolution no longer accepts sliced, optional or wrongly nested elements.
- Markdown reports escape `|` and HTML in table cells and messages.
- Orphaned Java processes after failed startups, and port reuse of a validator server loaded with other IGs.

### Security

- Downloaded tool JARs are verified against pinned SHA-256 checksums.

### Removed

- Remote validator mode (`--validator-server`, `--validator-token`, `COMPLIES_WITH_EU_VALIDATOR_SERVER`, `COMPLIES_WITH_EU_VALIDATOR_TOKEN`).

## [1.1.0]

Initial internal release.
