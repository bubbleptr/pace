import { homedir } from "node:os";
import * as piSdk from "@earendil-works/pi-coding-agent";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { createPiSdkDriver } from "./pi-sdk-driver";
import {
  createPublicPiSdkRuntimeFactory,
  createPublicPiSdkRuntimeForker,
  createPublicPiSdkRuntimeResumer,
} from "./pi-sdk-runtime-adapter";
import { serveSessionProcess } from "./session-process-server";
import { resolveAgentDir } from "../workspace/sessions";
import { createPaceModelRuntime } from "../workspace/account-models";
import { resolveDataDir } from "../persistence/session-event-journal";

registerBunOAuthFlows();
const agentDir = resolveAgentDir();
// Electron hands the backend PACE_DATA_DIR and this process inherits it, so
// the account model cache resolves to the same file the backend writes.
const dataDir = resolveDataDir(process.env, homedir());
const options = {
  sdk: piSdk,
  async sessionOptionsFor(input: { cwd: string }) {
    // Resume/fork use the cwd stored by Pi. This process owns only that root,
    // so changing cwd before loading extensions cannot affect other Sessions.
    process.chdir(input.cwd);
    const settingsManager = piSdk.SettingsManager.create(input.cwd, agentDir);
    const resourceLoader = new piSdk.DefaultResourceLoader({ cwd: input.cwd, agentDir, settingsManager });
    await resourceLoader.reload();
    const modelRuntime = await createPaceModelRuntime({ agentDir, dataDir });
    return { agentDir, settingsManager, resourceLoader, modelRuntime };
  },
};
serveSessionProcess(createPiSdkDriver({
  runtimeFactory: createPublicPiSdkRuntimeFactory(options),
  runtimeResumer: createPublicPiSdkRuntimeResumer(options),
  runtimeForker: createPublicPiSdkRuntimeForker(options),
}));
