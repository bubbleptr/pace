import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_DATA_DIR = join(getAgentDir(), "experimental", "durable-multiview", "default");

/** A client's `--url`, and `--token` or the token file a host on the same machine left in `--data-dir`. */
export async function hostAddress(argv: readonly string[]): Promise<{ url: string; token: string }> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "data-dir": { type: "string" },
      url: { type: "string", default: "ws://127.0.0.1:7420" },
      token: { type: "string" },
    },
  });
  const token = values.token ?? (await readFile(join(resolve(values["data-dir"] ?? DEFAULT_DATA_DIR), "token"), "utf8")).trim();
  return { url: values.url, token };
}
