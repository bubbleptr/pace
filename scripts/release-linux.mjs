import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseReleaseVersion } from "./release-version.mjs";

export function validateLinuxRelease({ tag, rootVersion, appVersion, platform, arch }) {
  const { version, prerelease } = parseReleaseVersion({ tag, rootVersion, appVersion });
  // stage:node-pty copies the host binary. An arm64 or macOS runner would ship the wrong module.
  if (platform !== "linux" || arch !== "x64") {
    throw new Error(`Linux releases require linux/x64; received ${platform}/${arch}.`);
  }

  return {
    version,
    prerelease,
    appImage: `Pace-${version}-x64.AppImage`,
    deb: `Pace-${version}-x64.deb`,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const repo = fileURLToPath(new URL("../", import.meta.url));
    const readVersion = path => JSON.parse(readFileSync(resolve(repo, path), "utf8")).version;
    const release = validateLinuxRelease({
      tag: process.argv[2],
      rootVersion: readVersion("package.json"),
      appVersion: readVersion("apps/desktop/package.json"),
      platform: process.platform,
      arch: process.arch,
    });
    const output = Object.entries(release).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
    process.stdout.write(output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
