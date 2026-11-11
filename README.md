<p align="center">
  <img src="https://raw.githubusercontent.com/Gefyra/complies-with-eu-cli/main/docs/assets/gefyra-logo.png" alt="Gefyra" width="180">
</p>

<h1 align="center">complies-with-eu</h1>

<p align="center">
  Check whether your FHIR profiles comply with the HL7 Europe profiles, using the <code>compliesWithProfile</code> extension and the official HL7 FHIR Validator.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-d32e22"></a>
  <a href="https://www.npmjs.com/package/@gefyra/complies-with-eu"><img alt="npm" src="https://img.shields.io/npm/v/@gefyra/complies-with-eu?color=d32e22"></a>
  <a href="https://github.com/Gefyra/complies-with-eu-cli/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Gefyra/complies-with-eu-cli/ci.yml?branch=main&label=CI"></a>
  <img alt="Node.js >= 20" src="https://img.shields.io/badge/node-%3E%3D20-d32e22">
</p>

---

## Contents

- [What it does and why](#what-it-does-and-why)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quickstart](#quickstart)
- [Commands](#commands)
- [Reading the results](#reading-the-results)
- [Exit codes and CI usage](#exit-codes-and-ci-usage)
- [Configuration](#configuration)
- [Files and directories](#files-and-directories)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Contributing, security and conduct](#contributing-security-and-conduct)
- [License](#license)

## What it does and why

The [European Health Data Space (EHDS)](https://health.ec.europa.eu/ehealth-digital-health-and-care/european-health-data-space-regulation-ehds_en) requires health data to be exchanged in a common European format. HL7 Europe publishes FHIR Implementation Guides for this purpose, such as [EU Base](https://build.fhir.org/ig/hl7-eu/base/), [Laboratory](https://build.fhir.org/ig/hl7-eu/laboratory/), the [Hospital Discharge Report](https://build.fhir.org/ig/hl7-eu/hdr/) and [ePrescription](https://build.fhir.org/ig/hl7-eu/eps/). National and project-specific profiles (for example the [International Patient Summary](https://hl7.org/fhir/uv/ips/) or German profiles) will have to fit these EU profiles.

FHIR has a standard way to state this: the [`compliesWithProfile`](http://hl7.org/fhir/StructureDefinition/structuredefinition-compliesWithProfile) extension on a StructureDefinition. It claims that every instance valid against your profile is also valid against the referenced profile. The [HL7 FHIR Validator](https://confluence.hl7.org/spaces/FHIR/pages/35718580/Using+the+FHIR+Validator) can check such claims.

`complies-with-eu` automates the whole check:

```
your package + profile canonical
        │
        ▼
find the EU profiles of the same resource type (from the pinned HL7 Europe packages)
        │
        ▼
add a compliesWithProfile extension for each selected EU profile
        │
        ▼
HL7 FHIR Validator  ──►  obligation check  ──►  constraint auto-resolution
        │
        ▼
Markdown report  (+ JSON for CI)
```

You get a per-EU-profile verdict (fulfilled / not fulfilled) and a report that explains each failure.

## Features

- **One command per profile, or a whole package at once.** `validate` checks one profile; `validate-batch` checks a list of profiles or every profile of a package that has EU counterparts.
- **Checks more than the validator does.** A static obligation check flags elements that an EU profile marks as `SHALL:able-to-populate` but your profile prohibits or does not flag as MustSupport.
- **Example instances.** `--examples` validates the package's example resources against the selected EU profiles.
- **CI ready.** Non-interactive flags, JSON output, an opt-in failing exit code, and a pinned, checksum-verified toolchain.

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Node.js | 20 or newer |
| Java | **21 or newer** on `PATH` or via `JAVA_HOME` (for example [Eclipse Temurin](https://adoptium.net)). The HL7 validator needs Java 17, but the pinned `fhir-pkg-tool` is built for Java 21. |
| Disk | About 1 GB free for the tools, the EU packages and the FHIR package cache (`~/.fhir/packages`) |
| Memory | 2 to 4 GB RAM for the validator JVM |
| Network | Outbound HTTPS to GitHub (tool downloads during `init`), the FHIR package registry (packages and their dependencies) and, for `search <canonical>`, simplifier.net |

Run `complies-with-eu doctor` at any time to check your setup.

## Installation

**Global install from npm**

```bash
npm install -g @gefyra/complies-with-eu
complies-with-eu --help
```

**Without installing (npx)**

```bash
npx @gefyra/complies-with-eu --help
```

**From source**

```bash
git clone https://github.com/Gefyra/complies-with-eu-cli.git
cd complies-with-eu-cli
npm ci
npm link   # optional: makes `complies-with-eu` available on your PATH
```

Without `npm link`, run `node bin/complies-with-eu.js` instead of `complies-with-eu`.

## Quickstart

This example checks the International Patient Summary patient profile against the EU core patient profile from HL7 Europe EU Base.

**1. Initialise (one time).** This downloads the pinned HL7 FHIR Validator and `fhir-pkg-tool` (see [`tools.json`](tools.json)) and all EU packages listed in [`eu-packages.json`](eu-packages.json).

```bash
complies-with-eu init
```

**2. Validate.** `--eu-profiles` selects the EU profile explicitly, so no prompt appears.

```bash
complies-with-eu validate hl7.fhir.uv.ips@2.0.0 \
  http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips \
  --eu-profiles http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core
```

To check against every EU profile of the same resource type, use `--all-counterparts` instead of `--eu-profiles`. Without either flag, an interactive checklist is shown.

The first run takes several minutes, because the validator downloads the IPS package, its dependencies and terminology packages into `~/.fhir/packages`. Later runs are much faster.

**3. Read the result.** The run ends with a verdict per EU profile and the report location:

```
Done!

  FAIL  http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core|2.0.1

  Report: ~/.complies-with-eu/workdir/hl7_org_fhir_uv_ips_StructureDefinition_Patient-uv-ips-report.md
```

Open the Markdown report to see why a profile is not fulfilled (see [Reading the results](#reading-the-results)).

A second example with a German package (gematik ISiK):

```bash
complies-with-eu validate de.gematik.isik@5.1.1 \
  https://gematik.de/fhir/isik/StructureDefinition/ISiKPatient --all-counterparts
```

## Commands

`<package>` always has the form `name[@version|#version]`. Without a version, `current` is used, which resolves to the newest version installed in `~/.fhir/packages`.

| Command | Purpose |
|---------|---------|
| [`init`](#init) | Download the pinned tools and all EU packages (one time) |
| [`doctor`](#doctor) | Check Node.js, Java, tools, EU packages and paths |
| [`validate`](#validate) | Validate one profile against EU profiles |
| [`validate-batch`](#validate-batch) | Validate a list of profiles (todo file) or a whole package |
| [`search`](#search) | Interactively pick a profile from a package, or a package for a canonical, then validate |
| [`build-index`](#build-index) | Write a JSON index of all StructureDefinitions in the EU packages |
| [`clean`](#clean) | Remove intermediate files from the workdir, keep reports |

Global options: `-V, --version` prints the version, `-h, --help` shows help. `complies-with-eu help <command>` shows the help of one command.

### init

```bash
complies-with-eu init [--force]
```

Checks Java first, then installs `validator_cli.jar` and `fhir-pkg-tool.jar` in the versions pinned in [`tools.json`](tools.json) into `~/.complies-with-eu/tools` (checksum-verified), and downloads all packages from [`eu-packages.json`](eu-packages.json) into `~/.fhir/packages`.

| Option | Description |
|--------|-------------|
| `--force` | Force re-download of the tools even if already present |

### doctor

```bash
complies-with-eu doctor [--json] [--workdir <dir>]
```

Shows the Node.js and Java versions, the installed tool versions compared with the pinned ones, the installed EU packages, and all paths. Exits with 2 if something is wrong.

| Option | Description |
|--------|-------------|
| `--json` | Output the diagnostics as JSON |
| `--workdir <dir>` | Workdir to report (default: `$COMPLIES_WITH_EU_WORKDIR` or `<home>/workdir`) |

### validate

```bash
complies-with-eu validate [options] <package> <canonical>
```

What happens:

1. The package is resolved from `~/.fhir/packages`, or downloaded via `fhir-pkg-tool` if it is missing or has no snapshots.
2. The profile with the given canonical is looked up; its resource type determines the candidate EU profiles.
3. The EU profiles are selected: `--eu-profiles`, else `--all-counterparts`, else an interactive checklist (pre-filled from your last selection for that canonical). Without a terminal, one of the two flags is required.
4. A copy of the profile with one `compliesWithProfile` extension per selected EU profile is validated by the HL7 FHIR Validator (locally, with the pinned version from `tools.json`).
5. The obligation check and constraint auto-resolution run, and a Markdown report is written.

| Option | Description |
|--------|-------------|
| `--eu-profiles <profiles>` | Comma-separated EU profile canonical URLs (skips interactive selection) |
| `--all-counterparts` | Use all EU profiles of the same resource type (no prompt) |
| `--examples` | Also validate all example instances of the matching FHIR type in the package |
| `--json` | Output result as JSON on stdout (machine-readable, for CI use; progress goes to stderr) |
| `--output <file>` | Write JSON output to file instead of stdout (requires `--json`) |
| `--fail-on-noncompliant` | Exit with code 1 if a selected EU profile is not fulfilled |
| `--workdir <dir>` | Directory for reports and intermediate files (default: `<home>/workdir`) |
| `--debug` | Print the full Java validator command, keep the raw output and show stack traces |

**`--examples`.** After the profile check, the example instances of the same resource type in the package (`package/example/` first, then `package/`) get a `meta.profile` claim for each selected EU profile and are validated in one validator run. The detailed report goes to `<workdir>/examples/<slug>/<slug>-examples-report.md`, and a summary table is appended to the profile report. With `--json`, the result includes an `examples` field.

### validate-batch

```bash
complies-with-eu validate-batch [options] <jsonFileOrPackage>
```

If the argument is an existing `.json` file, it runs in **todo-file mode**. Otherwise the argument is a package (`name[@version|#version]`) and it runs in **package mode**.

| Option | Description |
|--------|-------------|
| `--examples` | Also validate all example instances of the matching FHIR types |
| `--json` | Output result as JSON on stdout (machine-readable, for CI use; progress goes to stderr) |
| `--output <file>` | Write JSON output to file instead of stdout (requires `--json`) |
| `--fail-on-noncompliant` | Exit with code 1 if a selected EU profile is not fulfilled (2 if a profile could not be validated) |
| `--workdir <dir>` | Directory for reports and intermediate files (default: `<home>/workdir`) |
| `--mapping <file>` | Package mode: load EU counterpart mapping from external JSON file (skips prompts) |
| `--all-counterparts` | Package mode: use all matching EU profiles of the same type (no prompts) |
| `--reselect` | Package mode: force re-prompting even if `mapping.json` exists |
| `--type <types>` | Package mode: comma-separated resource types to filter (e.g. `Patient,Observation`) |
| `--server-port <port>` | Package mode: port for the local Java validator server (default: a free port; also `$VALIDATOR_SERVER_PORT`). A server already running there is reused only if it has the package loaded |
| `--debug` | Print the full Java validator command, keep the raw output and show stack traces |

#### Todo-file mode

The file is a JSON array of `{ package, version, profiles[] }` entries (`version` defaults to `current`). Every profile is checked against **all** EU profiles of its resource type, with no prompts. A profile that fails (download error, profile not found, validator crash) gets an error report and the run continues with the next one.

```json
[
  {
    "package": "hl7.fhir.uv.ips",
    "version": "2.0.0",
    "profiles": [
      "http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips",
      "http://hl7.org/fhir/uv/ips/StructureDefinition/AllergyIntolerance-uv-ips"
    ]
  }
]
```

```bash
complies-with-eu validate-batch todo.json --json --output result.json
```

#### Package mode

Validates every resource profile (`kind: resource`) of a package that has at least one EU profile of the same type. All profiles are validated by one local Java validator server, so the JVM starts only once.

```bash
# Non-interactive: all matching EU profiles for every profile
complies-with-eu validate-batch hl7.fhir.uv.ips@2.0.0 --all-counterparts

# Only some resource types
complies-with-eu validate-batch hl7.fhir.uv.ips@2.0.0 --type Patient,AllergyIntolerance --all-counterparts

# Interactive: choose EU counterparts per profile; the choice is saved as mapping.json
complies-with-eu validate-batch hl7.fhir.uv.ips@2.0.0

# Headless with a prepared mapping
complies-with-eu validate-batch hl7.fhir.uv.ips@2.0.0 --mapping mapping.json --json --output result.json
```

The EU counterparts are chosen in this order:

1. `--mapping <file>`
2. `--all-counterparts`
3. an existing `<workdir>/<pkgSlug>/mapping.json` (ignored with `--reselect`)
4. interactive prompts (terminal only, not with `--json`); a profile with exactly one EU counterpart is selected without a prompt
5. otherwise the run fails and points to `--mapping` and `--all-counterparts`

Mapping file format (also the format of the saved `mapping.json`):

```json
{
  "package": "hl7.fhir.uv.ips@2.0.0",
  "mappings": {
    "http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips": [
      "http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core"
    ],
    "http://hl7.org/fhir/uv/ips/StructureDefinition/AllergyIntolerance-uv-ips": []
  }
}
```

An empty array skips that profile; skipped profiles are not validated and do not appear in the results.

All artifacts of a package run live in `<workdir>/<pkgSlug>/`, where `pkgSlug` is the package spec with `.` and `@` replaced by `-` (for example `hl7-fhir-uv-ips-2-0-0`):

```
<workdir>/hl7-fhir-uv-ips-2-0-0/
  mapping.json            EU counterpart mapping (kept by clean)
  package-report.md       overview table linking to the profile reports
  <slug>-report.md        one report per profile
  modified/               profiles with the added compliesWithProfile extensions
  examples/<slug>/        example instances and reports (with --examples)
```

### search

```bash
complies-with-eu search [options] <packageOrCanonical>
```

Interactive helper; it needs a terminal and exits with 2 otherwise (use `validate` in scripts).

- **With a package**, it lists all resource profiles that have EU counterparts (sorted by resource type, with a mark for profiles that already have a saved EU selection) and runs `validate` on the one you pick.
- **With a canonical URL** (`http://` or `https://`), it asks [Simplifier.net](https://simplifier.net) which packages contain that canonical, lets you pick one, and runs `validate`.

```bash
complies-with-eu search hl7.fhir.uv.ips@2.0.0 --type Patient,Condition
complies-with-eu search http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips
```

| Option | Description |
|--------|-------------|
| `--type <types>` | Comma-separated resource types to filter (e.g. `Patient,Condition`) |
| `--eu-profiles <profiles>` | Passed to validate: comma-separated EU profile canonical URLs |
| `--all-counterparts` | Passed to validate: use all EU profiles of the same type |
| `--examples` | Passed to validate: also validate example instances |
| `--json` | Passed to validate: machine-readable output |
| `--output <file>` | Passed to validate: write JSON output to file (requires `--json`) |
| `--fail-on-noncompliant` | Passed to validate: exit with code 1 if a selected EU profile is not fulfilled |
| `--workdir <dir>` | Directory for reports and intermediate files (default: `<home>/workdir`) |
| `--debug` | Passed to validate: debug output and stack traces |

### build-index

```bash
complies-with-eu build-index [--output <file>]
```

Scans all EU packages from `eu-packages.json` and writes a JSON array of their StructureDefinitions (`url`, `name`, `id`, `type`, `kind`, `package`). Missing packages produce a warning; if none is installed, it exits with 2 instead of writing an empty index.

| Option | Description |
|--------|-------------|
| `--output <file>` | Write output to a file instead of stdout |

### clean

```bash
complies-with-eu clean [--workdir <dir>]
```

Deletes everything in the workdir except Markdown reports (`*-report.md`) and `mapping.json` files, then removes empty directories.

| Option | Description |
|--------|-------------|
| `--workdir <dir>` | Workdir to clean (default: `$COMPLIES_WITH_EU_WORKDIR` or `<home>/workdir`) |

## Reading the results

### Profile report

`<workdir>/<slug>-report.md`, where `<slug>` is the canonical without the scheme and with special characters replaced by `_` (for example `hl7_org_fhir_uv_ips_StructureDefinition_Patient-uv-ips`). Sections appear only when they have content:

| Section | Content |
|---------|---------|
| **compliesWithProfile — Overview** | How many of the checked EU profiles are fulfilled, with a ✅ / ❌ row per EU profile. An EU profile counts as not fulfilled if the validator rejects the claim **or** the obligation check finds a violation. |
| **Non-Compliant Profiles — Details** | Per failed EU profile, a table of element paths and the issue the validator reported (missing constraints, cardinality conflicts, slicing problems). |
| **Obligation Check (SHALL:able-to-populate)** | The HL7 validator does not evaluate obligations or MustSupport. For every element that an EU profile's differential marks `SHALL:able-to-populate`, this check looks at your profile's snapshot and reports the element if it is not found, has `max: 0`, or is not MustSupport. |
| **Automatically resolved constraints** | EU `.exists() or …` constraints that your profile does not declare, but that are guaranteed by its minimum cardinalities (unsliced elements with `min ≥ 1`). They are excluded from the verdict. |
| **Other Validation Results** | Collapsible list of all other validator messages (fatal, errors, warnings, information) that are not about `compliesWithProfile`. |
| **Example Validation** | Only with `--examples`: a status table per example file with error and warning counts, and a link to the detailed example report. |

If a profile cannot be processed (download error, profile not found, validator crash), an **error report** with the reason is written in place of the normal report.

The **example report** (`<workdir>/examples/<slug>/<slug>-examples-report.md`) lists the checked `meta.profile` claims, an overview (how many examples are error-free) and the issues per example, grouped by severity.

### JSON output

With `--json`, stdout contains only the JSON document (progress goes to stderr); with `--output <file>` it is written to the file instead. Fields may be added in future releases but are not removed or renamed.

**`validate`**

```json
{
  "compliance": [
    { "euCanonical": "http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core|2.0.1", "pass": false }
  ],
  "report": "# Compliance Report: Patient-uv-ips\n…",
  "pass": false,
  "package": "hl7.fhir.uv.ips@2.0.0",
  "canonical": "http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips",
  "reportPath": "/home/me/.complies-with-eu/workdir/hl7_org_fhir_uv_ips_StructureDefinition_Patient-uv-ips-report.md",
  "tool": { "name": "@gefyra/complies-with-eu", "version": "1.2.0", "validatorVersion": "7.0.5" },
  "validator": { "mode": "local", "summary": "…" },
  "euPackages": [ { "packageName": "hl7.fhir.eu.base", "version": "2.0.1" } ]
}
```

- `report` is the full Markdown report; `validator.mode` is always `local`; `validator.summary` is the validator's result summary line.
- With `--examples`, an `examples` object is added: `{ "reportPath", "total", "passed", "results": [ { "fileName", "pass", "errors", "warnings", "summary" } ] }`.

**`validate-batch` (todo-file mode)**

```json
{
  "mode": "file",
  "todoFile": "/abs/path/todo.json",
  "artifactsRoot": "/home/me/.complies-with-eu/workdir",
  "pass": false,
  "summary": { "total": 2, "success": 2, "failed": 0, "compliant": 1, "nonCompliant": 1, "errored": 0 },
  "profiles": [
    {
      "package": "hl7.fhir.uv.ips@2.0.0",
      "canonical": "http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips",
      "pass": false,
      "reportPath": "/home/me/.complies-with-eu/workdir/…-report.md",
      "compliance": [ { "euCanonical": "…", "pass": false } ]
    }
  ],
  "tool": { "…": "…" },
  "euPackages": [ "…" ]
}
```

A profile that could not be validated has `"error": "<message>"` and `"pass": false`.

**`validate-batch` (package mode)**

```json
{
  "package": "hl7.fhir.uv.ips@2.0.0",
  "artifactsRoot": "/home/me/.complies-with-eu/workdir/hl7-fhir-uv-ips-2-0-0",
  "summary": { "total": 2, "success": 2, "failed": 0, "compliant": 0, "nonCompliant": 2, "errored": 0 },
  "profiles": [
    {
      "canonical": "http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips",
      "slug": "hl7_org_fhir_uv_ips_StructureDefinition_Patient-uv-ips",
      "pass": false,
      "reportPath": "hl7_org_fhir_uv_ips_StructureDefinition_Patient-uv-ips-report.md",
      "compliance": [ { "euCanonical": "…", "pass": false } ]
    }
  ],
  "pass": false,
  "packageReportPath": "package-report.md",
  "tool": { "…": "…" },
  "euPackages": [ "…" ]
}
```

- `artifactsRoot` is absolute; `reportPath` and `packageReportPath` are relative to it.
- `summary.success` counts profiles that were validated (compliant or not), `summary.failed` and `summary.errored` count profiles that could not be validated, including profiles that failed during preparation.
- With `--examples`, each profile can carry an `examples` object (same shape as above); profiles that failed carry `error`.

## Exit codes and CI usage

| Code | Meaning |
|------|---------|
| `0` | Success, **also when profiles are non-compliant**, unless `--fail-on-noncompliant` is set |
| `1` | At least one selected EU profile is not fulfilled (only with `--fail-on-noncompliant`) |
| `2` | Usage or operational error: invalid arguments, Java missing, not initialised, package or profile not found, validator crash. In batch mode with `--fail-on-noncompliant`, also when a profile could not be validated. |

The default of `0` for non-compliant results is deliberate and stable, so existing pipelines that read the JSON keep working. Add `--fail-on-noncompliant` to make a CI job fail on non-compliance.

**GitHub Actions example**

```yaml
name: EU compliance
on: [push, pull_request]

jobs:
  complies-with-eu:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 21

      - name: Cache tools and FHIR packages
        uses: actions/cache@v4
        with:
          path: |
            ~/.complies-with-eu/tools
            ~/.fhir/packages
          key: complies-with-eu-${{ runner.os }}-1.2.0

      - run: npm install -g @gefyra/complies-with-eu@1.2.0
      - run: complies-with-eu init

      - name: Validate
        run: |
          complies-with-eu validate hl7.fhir.uv.ips@2.0.0 \
            http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips \
            --eu-profiles http://hl7.eu/fhir/base/StructureDefinition/patient-eu-core \
            --json --output result.json --fail-on-noncompliant

      - name: Upload reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: complies-with-eu-reports
          path: |
            result.json
            ~/.complies-with-eu/workdir/**/*-report.md
```

Include the CLI version in the cache key: a new release can pin different tool versions, and `init` then downloads them again.

## Configuration

The files below are read from the installation directory of the package. With a global npm install they are replaced on every update, so to change them, work from a source checkout.

### EU packages (`eu-packages.json`)

`eu-packages.json` is the single source of truth for the CLI and the EU profile index (`build-index`). Published releases are pinned so results are reproducible. `current` (CI build) should only be used where no up-to-date release exists yet.

| Package | Version | Note |
|---------|---------|------|
| `hl7.fhir.eu.base` | `2.0.1` | STU release |
| `hl7.fhir.eu.laboratory` | `2.1.0` | STU release |
| `hl7.fhir.eu.mpd` | `1.0.0` | STU release |
| `hl7.fhir.eu.hdr` | `1.0.0` | STU release |
| `hl7.fhir.eu.eps` | `1.0.0-ballot` | latest publication |
| `hl7.fhir.eu.imaging` | `1.0.0-ballot` | latest publication |
| `hl7.fhir.eu.health-data-api` | `1.0.0-ballot` | latest publication |

When a new release is published, bump the version here and run `complies-with-eu init` to download it. See [CONTRIBUTING.md](CONTRIBUTING.md#updating-the-eu-packages).

### Tool versions (`tools.json`)

Pins the external tools that `init` downloads, with exact URL and SHA-256 checksum:

| Tool | Version | License | Minimum Java |
|------|---------|---------|--------------|
| HL7 FHIR Validator (`validator_cli.jar`, [hapifhir/org.hl7.fhir.core](https://github.com/hapifhir/org.hl7.fhir.core)) | `7.0.5` | Apache-2.0 | 17 |
| `fhir-pkg-tool.jar` ([Gefyra/fhir-pkg-tool](https://github.com/Gefyra/fhir-pkg-tool)) | `v0.5.0` | MIT | 21 |

A download whose checksum does not match is rejected and leaves no file behind. To try another version, set `COMPLIES_WITH_EU_VALIDATOR_VERSION` or `COMPLIES_WITH_EU_FHIR_PKG_TOOL_VERSION` to `latest` or a release tag and run `init --force`. Such downloads are **not** checksum-verified, and a warning is printed. Installed versions are recorded in `~/.complies-with-eu/tools/versions.json`.

### Validator parameters (`java-validator-parameter.md`)

Extra options for the local HL7 FHIR Validator, one `-flag` or `-key value` per line; lines starting with `#` are comments. `-output` and `-html-output` are ignored because the CLI parses the console output itself. The `-ig` entries for the EU packages, the validated package and its dependencies are added automatically. The shipped defaults:

| Line | Effect |
|------|--------|
| `-allow-example-urls true` | Accept `example.org` style URLs in examples |
| `-verbose` | Extended validator output |
| `-display-issues-are-warnings` | Report display mismatches as warnings |
| `-tx n/a` | No terminology server: faster, works offline, but codes are not validated against terminology |
| `-version 4.0.1` | FHIR R4 |
| `-locale en` | English messages |
| `-jurisdiction global` | No national jurisdiction context |
| `-ig de.basisprofil.r4#1.5.4` | Loaded on purpose for every run: many German packages reference it without declaring it as a dependency. It does not change results for packages that do not use it. |

These parameters apply to `validate`, `validate-batch` and the local validator server in package mode.

### Environment variables

| Variable | Description |
|----------|-------------|
| `COMPLIES_WITH_EU_HOME` | State directory (default `~/.complies-with-eu`: `tools/`, `workdir/`, `cache.json`) |
| `COMPLIES_WITH_EU_WORKDIR` | Reports and intermediate files (default `<home>/workdir`); `--workdir` takes precedence |
| `COMPLIES_WITH_EU_VALIDATOR_VERSION` | Override the pinned HL7 validator version (`latest` or a tag; not checksum-verified) |
| `COMPLIES_WITH_EU_FHIR_PKG_TOOL_VERSION` | Override the pinned fhir-pkg-tool version (not checksum-verified) |
| `VALIDATOR_SERVER_PORT` | Port of the local validator server in package mode |
| `JAVA_HOME` | Java installation to use (otherwise `java` on `PATH`) |
| `GITHUB_TOKEN` | Sent to GitHub (only `github.com` / `api.github.com`) when downloading tools, to avoid rate limits |
| `DEBUG` | Print stack traces on errors |

## Files and directories

| Path | Content | How to reset |
|------|---------|--------------|
| `~/.complies-with-eu/tools/` | `validator_cli.jar`, `fhir-pkg-tool.jar`, `versions.json` | `complies-with-eu init --force` |
| `~/.complies-with-eu/workdir/` | Reports (`*-report.md`), modified profiles (`*-modified.json`), raw validator logs (`*-raw.log`, with `--debug` or when the validator fails), `examples/`, package-mode folders | `complies-with-eu clean` (keeps reports and `mapping.json`), or delete the folder |
| `~/.complies-with-eu/cache.json` | Your last interactive EU profile selection per canonical | Delete the file |
| `~/.fhir/packages/` | Standard FHIR package cache, shared with other FHIR tools. Holds the EU packages, your packages and their dependencies. | Delete individual `name#version` folders; they are downloaded again when needed |

`~/.complies-with-eu` can be moved with `COMPLIES_WITH_EU_HOME`, the workdir with `COMPLIES_WITH_EU_WORKDIR` or `--workdir`.

Versions up to 1.1.x kept their state inside the installation directory (`.tools/`, `workdir/`, `.complies-with-cache.json`). A complete legacy `.tools/` folder is still used as long as `~/.complies-with-eu/tools` is not complete, and the legacy cache file is still read and merged into `cache.json` on the next save. `init` copies checksum-matching jars from the legacy folder. `doctor` shows which locations are in use.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `complies-with-eu is not initialised (missing: …)` | Run `complies-with-eu init`. Check with `complies-with-eu doctor`. |
| Java not found, or version too old | Install Java 21+ (for example [Temurin](https://adoptium.net)) and put it on `PATH` or set `JAVA_HOME`. |
| `init` fails with a GitHub rate limit | Set `GITHUB_TOKEN` to any GitHub token and retry. |
| `init` reports a checksum mismatch | The download was corrupted or altered (for example by a proxy). Retry; if it persists, check your network. |
| `EU profile selection required, but no interactive terminal is available` | In CI or with `--json`, pass `--eu-profiles <url1,url2>` or `--all-counterparts`. |
| `search is interactive and needs a terminal` | Use `validate` with `--eu-profiles` or `--all-counterparts` in scripts. |
| `--output requires --json` | Add `--json`. |
| `Package '…' could not be downloaded` | Check the package name and version (for example on [packages.fhir.org](https://packages.fhir.org)), or try `complies-with-eu search <canonical>`. |
| Profile not found | The canonical is not in that package version. List the profiles with `complies-with-eu search <package>`. |
| `… produced no result summary` | The validator crashed (often out of memory or a broken jar). Open the raw log named in the message, rerun with `--debug`, or reinstall the tools with `init --force`. |
| First run takes several minutes | The validator downloads dependencies and terminology packages into `~/.fhir/packages` once. |
| `--server-port` fails | Something else is running on that port, or a validator server without your package. Omit the option to use a free port. |

## Limitations

- **FHIR R4 only.** The validator runs with `-version 4.0.1`, matching the HL7 Europe IGs.
- **No terminology validation by default** (`-tx n/a`). Value set bindings are not checked against a terminology server.
- **Ballot packages.** Some EU IGs are only available as ballot versions (see the table above); their profiles can still change.
- **The verdict is as good as the validator's `compliesWithProfile` check**, which is still evolving. The obligation check only covers `SHALL:able-to-populate` in the EU profiles' differentials, and constraint auto-resolution only covers `.exists() or …` constraints guaranteed by minimum cardinalities.
- **EU counterparts are found by type only.** Candidates are the EU profiles with the same `type` as your profile; package mode and `search` only consider resource profiles (no extensions or data type profiles).
- **`search <canonical>` depends on the Simplifier.net resolve page** and can break if that page changes.

## Contributing, security and conduct

- [CONTRIBUTING.md](CONTRIBUTING.md): development setup, coding rules and pull requests
- [SECURITY.md](SECURITY.md): how to report a vulnerability privately
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): Contributor Covenant 2.1
- [CHANGELOG.md](CHANGELOG.md): release history

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Gefyra GmbH.

`init` downloads third-party tools at runtime; they are not part of this package: the HL7 FHIR Validator (Apache-2.0) and fhir-pkg-tool (MIT). FHIR packages, including the HL7 Europe Implementation Guides, keep their own licenses. See [NOTICE](NOTICE).

<p align="center">Maintained by <a href="https://gefyra.de">Gefyra GmbH</a></p>
