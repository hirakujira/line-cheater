"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CACHE_VERSION_FILE = ".line-cheater-cache-version";
const SESSION_KEY_PATTERN = /^[0-9a-f]{64}$/;

function sessionRoot(userDataPath) {
  return path.resolve(userDataPath, "sessions");
}

function sessionWorkDir(userDataPath, sourcePath) {
  const source = path.resolve(sourcePath);
  const key = crypto.createHash("sha256").update(source).digest("hex");
  return path.join(sessionRoot(userDataPath), key);
}

function assertManagedSessionPath(userDataPath, workDir) {
  const root = sessionRoot(userDataPath);
  const candidate = path.resolve(workDir);
  if (path.dirname(candidate) !== root ||
      !SESSION_KEY_PATTERN.test(path.basename(candidate))) {
    throw new Error("Refusing to modify a path outside the managed session cache.");
  }
  return candidate;
}

function clearSessionCache(userDataPath, workDir) {
  const candidate = assertManagedSessionPath(userDataPath, workDir);
  fs.rmSync(candidate, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
}

function cachedVersion(workDir) {
  try {
    if (fs.lstatSync(workDir).isSymbolicLink()) return null;
    const marker = path.join(workDir, CACHE_VERSION_FILE);
    if (!fs.lstatSync(marker).isFile()) return null;
    return fs.readFileSync(marker, "utf8").trim();
  } catch {
    return null;
  }
}

function writeVersionMarker(workDir, version) {
  const marker = path.join(workDir, CACHE_VERSION_FILE);
  const temporary = path.join(
    workDir,
    `${CACHE_VERSION_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, `${version}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.rmSync(marker, { force: true });
    fs.renameSync(temporary, marker);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function prepareSessionCache(userDataPath, sourcePath, appVersion, compatibleVersions = []) {
  const version = String(appVersion || "").trim();
  if (!version || /[\r\n]/.test(version)) {
    throw new TypeError("A valid LINE Cheater version is required for session caching.");
  }
  if (!Array.isArray(compatibleVersions) ||
      compatibleVersions.some((item) => typeof item !== "string" || !item || /[\r\n]/.test(item))) {
    throw new TypeError("Compatible cache versions must be valid version strings.");
  }
  const workDir = sessionWorkDir(userDataPath, sourcePath);
  const previousVersion = cachedVersion(workDir);
  if (previousVersion === version) {
    return { workDir, recreated: false, migrated: false };
  }
  if (previousVersion && compatibleVersions.includes(previousVersion)) {
    writeVersionMarker(workDir, version);
    return { workDir, recreated: false, migrated: true };
  }
  clearSessionCache(userDataPath, workDir);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  writeVersionMarker(workDir, version);
  return { workDir, recreated: true, migrated: false };
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`));
}

function outputFallsInsideSession(workDir, outputPath) {
  if (isWithin(workDir, outputPath)) return true;
  try {
    const realWorkDir = fs.realpathSync(workDir);
    const realOutputParent = fs.realpathSync(path.dirname(path.resolve(outputPath)));
    return isWithin(realWorkDir, path.join(realOutputParent, path.basename(outputPath)));
  } catch {
    return false;
  }
}

module.exports = {
  CACHE_VERSION_FILE,
  clearSessionCache,
  outputFallsInsideSession,
  prepareSessionCache,
  sessionWorkDir
};
