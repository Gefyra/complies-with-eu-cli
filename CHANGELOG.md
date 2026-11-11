# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
