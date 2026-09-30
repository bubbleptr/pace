export function parseReleaseVersion({ tag, rootVersion, appVersion }) {
  const match = typeof tag === "string"
    ? /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag)
    : null;
  if (!match || match[0] !== tag || match[4]?.split(".").some(part => /^0\d+$/.test(part))) {
    throw new Error("Release tag must be vMAJOR.MINOR.PATCH, with optional SemVer prerelease and build metadata.");
  }

  const version = tag.slice(1);
  for (const [name, actual] of [["root package.json", rootVersion], ["apps/desktop/package.json", appVersion]]) {
    if (actual !== version) throw new Error(`${name} version ${actual} does not match release tag ${tag}.`);
  }

  return { version, prerelease: Boolean(match[4]) };
}
