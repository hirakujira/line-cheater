"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CACHE_VERSION_FILE,
  clearSessionCache,
  outputFallsInsideSession,
  prepareSessionCache,
  sessionWorkDir
} = require("./session-cache.cjs");

function temporaryUserData(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "line-cheater-cache-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("keeps same-version cache and rebuilds cache after an app version change", (t) => {
  const userData = temporaryUserData(t);
  const source = path.join(userData, "source.imazingapp");
  const first = prepareSessionCache(userData, source, "1.2.3");
  assert.equal(first.recreated, true);
  assert.equal(
    fs.readFileSync(path.join(first.workDir, CACHE_VERSION_FILE), "utf8").trim(),
    "1.2.3"
  );
  const retained = path.join(first.workDir, "catalog.sqlite");
  fs.writeFileSync(retained, "derived cache");

  const same = prepareSessionCache(userData, source, "1.2.3");
  assert.equal(same.recreated, false);
  assert.equal(fs.readFileSync(retained, "utf8"), "derived cache");

  const upgraded = prepareSessionCache(userData, source, "1.2.4");
  assert.equal(upgraded.recreated, true);
  assert.equal(fs.existsSync(retained), false);
  assert.equal(
    fs.readFileSync(path.join(upgraded.workDir, CACHE_VERSION_FILE), "utf8").trim(),
    "1.2.4"
  );
});

test("only clears hashed session directories and detects unsafe candidate outputs", (t) => {
  const userData = temporaryUserData(t);
  const source = path.join(userData, "source.imazingapp");
  const workDir = sessionWorkDir(userData, source);
  prepareSessionCache(userData, source, "1.0.0");
  assert.equal(
    outputFallsInsideSession(workDir, path.join(workDir, "candidate.imazingapp")),
    true
  );
  assert.equal(
    outputFallsInsideSession(workDir, path.join(userData, "candidate.imazingapp")),
    false
  );
  assert.throws(
    () => clearSessionCache(userData, path.join(userData, "sessions")),
    /outside the managed session cache/
  );
  clearSessionCache(userData, workDir);
  assert.equal(fs.existsSync(workDir), false);
});
