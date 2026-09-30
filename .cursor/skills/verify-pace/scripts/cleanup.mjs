#!/usr/bin/env node
// Tear down a verification Electron that this skill started.
// Kills only the recorded pid, and only when its command line contains the
// recorded disposable --user-data-dir. Deletes that temp root. Leaves evidence.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return null;
  }
  return process.argv[index + 1];
}

const evidenceDir = argValue("--evidence");
if (!evidenceDir) {
  process.stderr.write("usage: cleanup.mjs --evidence <dir>\n");
  process.exit(2);
}

const instancePath = path.join(evidenceDir, "instance.json");
if (!existsSync(instancePath)) {
  process.stdout.write(`no instance.json in ${evidenceDir}; nothing to clean\n`);
  process.exit(0);
}

const instance = JSON.parse(readFileSync(instancePath, "utf8"));

function cmdline(pid) {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ");
    } catch {
      return null;
    }
  }

  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  } catch {
    return null;
  }
}

function isDisposableRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    return false;
  }
  const resolved = path.resolve(root);
  const tmp = path.resolve(os.tmpdir());
  return (
    resolved.startsWith(tmp + path.sep) &&
    path.basename(resolved).startsWith("pace-e2e-")
  );
}

if (!instance.closed && typeof instance.pid === "number") {
  const userDataDir = instance.userDataDir;
  const line = cmdline(instance.pid);
  const ownsProfile =
    typeof userDataDir === "string" &&
    userDataDir.includes(`${path.sep}pace-e2e-`) &&
    line !== null &&
    line.includes(userDataDir);

  if (line === null) {
    process.stdout.write(`pid ${instance.pid} is already gone\n`);
  } else if (!ownsProfile) {
    process.stderr.write(
      `refusing to kill pid ${instance.pid}; command line does not contain the recorded pace-e2e user-data-dir\n`,
    );
    process.exit(1);
  } else {
    try {
      process.kill(instance.pid, "SIGTERM");
      process.stdout.write(`sent SIGTERM to pid ${instance.pid}\n`);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "";
      if (code !== "ESRCH") {
        throw error;
      }
    }
  }
}

if (isDisposableRoot(instance.testRoot) && existsSync(instance.testRoot)) {
  rmSync(instance.testRoot, { recursive: true, force: true });
  process.stdout.write(`removed ${instance.testRoot}\n`);
} else if (instance.testRoot && existsSync(instance.testRoot)) {
  process.stdout.write(`left ${instance.testRoot} in place (not a pace-e2e temp root)\n`);
}

const closed = {
  ...instance,
  closed: true,
  pid: null,
  cleanedAt: new Date().toISOString(),
};
writeFileSync(instancePath, `${JSON.stringify(closed, null, 2)}\n`);
process.stdout.write(`evidence kept at ${path.resolve(evidenceDir)}\n`);
