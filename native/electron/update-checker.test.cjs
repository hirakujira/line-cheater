"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  LATEST_RELEASE_API,
  RELEASES_URL,
  compareVersions,
  findAvailableUpdate,
  parseVersion,
  trustedReleaseUrl
} = require("./update-checker.cjs");

function releaseResponse(release, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(release);
    }
  };
}

test("parses and compares release versions", () => {
  assert.deepEqual(parseVersion("v1.2.3"), {
    core: [1, 2, 3],
    prerelease: []
  });
  assert.equal(compareVersions("v1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2.3", "v1.2.3"), 0);
  assert.equal(compareVersions("1.2.3-beta.2", "1.2.3-beta.10"), -1);
  assert.equal(compareVersions("1.2.3", "1.2.3-rc.1"), 1);
  assert.equal(compareVersions("not-a-version", "1.2.3"), null);
});

test("returns a newer stable GitHub release", async () => {
  let requestedUrl = null;
  const update = await findAvailableUpdate("0.1.18", async (url, options) => {
    requestedUrl = url;
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Accept, "application/vnd.github+json");
    assert.ok(options.signal);
    return releaseResponse({
      tag_name: "v0.1.19",
      draft: false,
      prerelease: false,
      html_url: "https://github.com/zeuikli/line-cheater/releases/tag/v0.1.19"
    });
  });
  assert.equal(requestedUrl, LATEST_RELEASE_API);
  assert.deepEqual(update, {
    currentVersion: "0.1.18",
    latestVersion: "0.1.19",
    releaseUrl: "https://github.com/zeuikli/line-cheater/releases/tag/v0.1.19"
  });
});

test("ignores current, older, draft, prerelease, and malformed releases", async () => {
  for (const release of [
    { tag_name: "v0.1.18", draft: false, prerelease: false },
    { tag_name: "v0.1.17", draft: false, prerelease: false },
    { tag_name: "v0.1.19", draft: true, prerelease: false },
    { tag_name: "v0.1.19", draft: false, prerelease: true },
    { tag_name: "latest", draft: false, prerelease: false }
  ]) {
    assert.equal(
      await findAvailableUpdate("0.1.18", async () => releaseResponse(release)),
      null
    );
  }
});

test("only accepts release links from the configured GitHub repository", () => {
  assert.equal(
    trustedReleaseUrl("https://github.com/zeuikli/line-cheater/releases/tag/v1.0.0"),
    "https://github.com/zeuikli/line-cheater/releases/tag/v1.0.0"
  );
  assert.equal(
    trustedReleaseUrl("https://example.com/download"),
    RELEASES_URL
  );
});

test("reports GitHub request failures to the caller", async () => {
  await assert.rejects(
    findAvailableUpdate("0.1.18", async () => releaseResponse({}, 503)),
    /HTTP 503/
  );
});
