# Security Policy

## Supported versions

Security fixes are only made for the latest code. Older releases are not patched.

| Component | Supported |
|-----------|-----------|
| CLI `@gefyra/complies-with-eu`: latest release on npm and the `main` branch | Yes |
| Older releases | No. Please upgrade |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Report them privately through GitHub's private vulnerability reporting:

1. Open the repository on GitHub and go to the **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the CLI version, steps to reproduce, and the impact you expect.

We aim to acknowledge your report within **5 business days**. We will keep you informed while we work on a fix and coordinate the disclosure date with you. If you wish, we will credit you in the release notes.

## Scope

In scope:

- The `complies-with-eu` CLI (`bin/`, `src/`), for example command or argument injection, unsafe file handling, or the integrity of downloaded tools.

Out of scope:

- Vulnerabilities in third-party tools that are downloaded at runtime (HL7 FHIR Validator, fhir-pkg-tool) or in FHIR packages. Please report them to their maintainers. Let us know as well if our way of using them makes the issue worse.
