#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../../..');
const cargoPath = path.join(repositoryRoot, 'native/core/Cargo.toml');
const lockPath = path.join(repositoryRoot, 'Cargo.lock');
const packagePath = path.join(repositoryRoot, 'native/electron/package.json');
const packageLockPath = path.join(repositoryRoot, 'native/electron/package-lock.json');
const dryRun = process.argv.includes('--dry-run');

const cargo = fs.readFileSync(cargoPath, 'utf8');
const cargoVersion = cargo.match(/^version = "(\d+)\.(\d+)\.(\d+)"/m);
if (!cargoVersion) {
  throw new Error(`Could not find the package version in ${cargoPath}`);
}

const current = cargoVersion.slice(1).join('.');
const next = `${cargoVersion[1]}.${cargoVersion[2]}.${Number(cargoVersion[3]) + 1}`;
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const packageLockJson = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));

if (
  packageJson.version !== current ||
  packageLockJson.version !== current ||
  packageLockJson.packages[''].version !== current
) {
  throw new Error(`Version files are out of sync with ${cargoPath}: expected ${current}`);
}

const updatedCargo = cargo.replace(
  /^version = "\d+\.\d+\.\d+"/m,
  `version = "${next}"`,
);

const lock = fs.readFileSync(lockPath, 'utf8');
const lockPattern = /(\[\[package\]\]\r?\nname = "line-cheater"\r?\nversion = ")([^\"]+)(")/;
if (!lockPattern.test(lock)) {
  throw new Error(`Could not find line-cheater in ${lockPath}`);
}
const updatedLock = lock.replace(lockPattern, `$1${next}$3`);

packageJson.version = next;
packageLockJson.version = next;
packageLockJson.packages[''].version = next;

if (!dryRun) {
  fs.writeFileSync(cargoPath, updatedCargo);
  fs.writeFileSync(lockPath, updatedLock);
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLockJson, null, 2)}\n`);
}

console.log(`${current} -> ${next}`);
