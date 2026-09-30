import assert from "node:assert/strict";
import test from "node:test";
import { validateLinuxRelease } from "./release-linux.mjs";

const valid = {
  tag: "v0.0.1",
  rootVersion: "0.0.1",
  appVersion: "0.0.1",
  platform: "linux",
  arch: "x64",
};

test("a matching stable tag produces the x64 AppImage and deb names", () => {
  assert.deepEqual(validateLinuxRelease(valid), {
    version: "0.0.1",
    prerelease: false,
    appImage: "Pace-0.0.1-x64.AppImage",
    deb: "Pace-0.0.1-x64.deb",
  });
});

test("prerelease tags retain their full version", () => {
  assert.deepEqual(validateLinuxRelease({
    ...valid,
    tag: "v1.2.3-rc.1",
    rootVersion: "1.2.3-rc.1",
    appVersion: "1.2.3-rc.1",
  }), {
    version: "1.2.3-rc.1",
    prerelease: true,
    appImage: "Pace-1.2.3-rc.1-x64.AppImage",
    deb: "Pace-1.2.3-rc.1-x64.deb",
  });
});

test("Linux packaging must run on linux/x64 so node-pty matches the artifact", () => {
  assert.throws(() => validateLinuxRelease({ ...valid, arch: "arm64" }), /linux\/x64/);
  assert.throws(() => validateLinuxRelease({ ...valid, platform: "darwin" }), /linux\/x64/);
});

test("a tag cannot label binaries built with a different application version", () => {
  assert.throws(() => validateLinuxRelease({ ...valid, appVersion: "0.0.9" }), /apps\/desktop\/package\.json/);
  assert.throws(() => validateLinuxRelease({ ...valid, tag: "main" }), /tag/);
});
