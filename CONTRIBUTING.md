# Contributing to complies-with-eu

Thank you for your interest in improving `complies-with-eu`. This document explains how to set up a development environment and how changes get merged.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Repository layout

| Path | Content |
|------|---------|
| `bin/`, `src/` | The `complies-with-eu` CLI (Node.js, CommonJS) |
| `eu-packages.json` | Pinned EU FHIR packages used by the CLI |
| `java-validator-parameter.md` | Extra parameters passed to the HL7 FHIR Validator |

## Development setup

Prerequisites:

- Node.js **20 or newer**
- Java **21 or newer** (the pinned fhir-pkg-tool is built for Java 21)
- Git

```bash
git clone https://github.com/Gefyra/complies-with-eu-cli.git
cd complies-with-eu-cli
npm ci

# Download the validator JARs and the EU packages
node bin/complies-with-eu.js init

# Try it out
node bin/complies-with-eu.js --help
```

## Tests and linting

Run these before you open a pull request:

```bash
npm test
npm run lint
```

New behaviour should come with tests. Bug fixes should include a test that fails without the fix where practical.

## Coding guidelines

- **CommonJS only.** Use `require` / `module.exports`, not ES modules. The package is `"type": "commonjs"`.
- **English only for all user-facing text.** This covers CLI output, prompts, error messages, generated reports and documentation. Code comments should be in English, too.
- **Keep the CLI's machine-readable output backward compatible.** The JSON written by `--json` / `--output` is consumed by automated pipelines. You may add fields. Do not remove, rename or retype existing fields.
- **Keep command names, flags and exit codes stable.** By default the CLI exits with `0` even when a profile is not compliant. Non-zero exit codes on non-compliance are opt-in (`--fail-on-noncompliant`). Operational errors exit non-zero.
- Write machine output (`--json`) to stdout only. Progress and logs go to stderr.
- Keep dependencies minimal. Explain any new runtime dependency in the pull request.

## Updating the EU packages

`eu-packages.json` is the single source of truth for the EU packages. The CLI (`init`) and the EU profile index (`build-index`) use it. Versions are pinned to published releases so that results are reproducible.

To bump a package:

1. Change the `version` of the entry in `eu-packages.json`. Use a published release; use `current` only if no up-to-date release exists.
2. Update the table under Configuration > [EU packages](README.md#eu-packages-eu-packagesjson) in `README.md`.
3. Re-download locally and check the result:
   ```bash
   node bin/complies-with-eu.js init           # downloads the new package version
   node bin/complies-with-eu.js validate <package@version> <canonical>
   ```
4. Add an entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

Note: `--force` applies to the tools (`validator_cli.jar`, `fhir-pkg-tool.jar`) only; it is not needed to pick up a new EU package version.

## Pull request process

1. For larger changes, open an issue first so we can agree on the approach.
2. Fork the repository and create a topic branch from `main` (e.g. `fix/report-encoding`, `feat/fail-on-noncompliant`).
3. Keep pull requests focused. Unrelated refactoring belongs in a separate PR.
4. Make sure `npm test` and `npm run lint` pass. Update documentation (`README.md`) and `CHANGELOG.md` ("Unreleased").
5. Open the pull request and fill in the template. A maintainer reviews it. Please respond to review comments, and we will merge when it is ready.

## Licensing of contributions

This project is licensed under the [Apache License 2.0](LICENSE). Contributions are accepted under the same license ("inbound = outbound", see section 5 of the license). You do **not** need to sign a Contributor License Agreement or add a DCO `Signed-off-by` line. By submitting a pull request you confirm that you have the right to contribute the code under this license.
