import fs from 'fs-extra';
import { loadEuPackages } from '../lib/config.js';
import { resolvePackageDir } from '../lib/fhirPkgTool.js';
import { findAllProfilesInPackage } from '../lib/profileUtils.js';
import { CliError } from '../lib/errors.js';

/**
 * Scans all EU packages and writes a flat JSON array of StructureDefinitions
 * to the given output path (default: stdout). Warnings go to stderr.
 *
 * Each entry: { url, name, id, type, kind, package }
 */
async function runBuildIndex(options = {}) {
  const packages = loadEuPackages();
  const index = [];
  let resolved = 0;

  for (const pkg of packages) {
    let pkgDir;
    try {
      pkgDir = await resolvePackageDir(pkg.packageName, pkg.version);
    } catch (err) {
      process.stderr.write(`Warning: could not resolve ${pkg.packageName}@${pkg.version}: ${err.message}\n`);
      continue;
    }
    resolved++;

    const profiles = await findAllProfilesInPackage(pkgDir);
    for (const p of profiles) {
      index.push({ ...p, package: `${pkg.packageName}@${pkg.version}` });
    }
  }

  if (resolved === 0) {
    // Never emit an empty index just because nothing is installed
    throw new CliError('None of the EU packages from eu-packages.json is installed.\nRun: complies-with-eu init');
  }

  const json = JSON.stringify(index, null, 2);

  if (options.output) {
    await fs.outputFile(options.output, json, 'utf8');
    process.stderr.write(`Index with ${index.length} StructureDefinition(s) written to ${options.output}\n`);
  } else {
    process.stdout.write(json + '\n');
  }
}

export { runBuildIndex };
