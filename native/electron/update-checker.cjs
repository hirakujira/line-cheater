"use strict";

const LATEST_RELEASE_API =
  "https://api.github.com/repos/zeuikli/line-cheater/releases/latest";
const RELEASES_URL = "https://github.com/zeuikli/line-cheater/releases";
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function parseVersion(value) {
  const match = String(value || "").trim().match(
    /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  return {
    core,
    prerelease: match[4] ? match[4].split(".") : []
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference !== 0) return Math.sign(difference);
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) return null;
  for (let index = 0; index < left.core.length; index += 1) {
    const difference = left.core[index] - right.core[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function trustedReleaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" ||
        url.hostname !== "github.com" ||
        url.username ||
        url.password ||
        !url.pathname.startsWith("/zeuikli/line-cheater/releases/")) {
      return RELEASES_URL;
    }
    return url.href;
  } catch {
    return RELEASES_URL;
  }
}

async function findAvailableUpdate(currentVersion, fetchImpl, options = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }
  if (!parseVersion(currentVersion)) {
    throw new TypeError("The current application version is invalid.");
  }
  const controller = new AbortController();
  const timeoutMs = Number.isSafeInteger(options.timeoutMs)
    ? Math.max(1, options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "Cache-Control": "no-cache",
        "User-Agent": "LINE-Cheater-Update-Check",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`GitHub release request failed with HTTP ${response.status}.`);
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("GitHub release response is too large.");
    }
    const release = JSON.parse(body);
    if (!release ||
        release.draft === true ||
        release.prerelease === true ||
        typeof release.tag_name !== "string") {
      return null;
    }
    const comparison = compareVersions(release.tag_name, currentVersion);
    if (comparison === null || comparison <= 0) return null;
    return {
      currentVersion: String(currentVersion),
      latestVersion: release.tag_name.replace(/^[vV]/, ""),
      releaseUrl: trustedReleaseUrl(release.html_url)
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  LATEST_RELEASE_API,
  RELEASES_URL,
  compareVersions,
  findAvailableUpdate,
  parseVersion,
  trustedReleaseUrl
};
