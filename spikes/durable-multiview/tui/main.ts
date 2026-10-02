#!/usr/bin/env node
// pi's durable TUI as a remote client: the same rendering, fed by a host's gateway
// instead of an in-process Harness. Settings (theme, keybindings, terminal
// capabilities) are this machine's, the conversation is the host's.
//
//   node tui/main.ts [--data-dir DIR | --token T] [--url ws://127.0.0.1:7420]
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { hostAddress } from "../cli/host-address.ts";
import { connectRemoteDurable } from "../protocol/remote-durable.ts";
import { runDurableTui } from "./tui.ts";

const remote = await connectRemoteDurable({ ...(await hostAddress(process.argv.slice(2))), clientName: "tui" });
// As in pi's durable TUI, the task panel starts open; /tasks hides it.
await remote.controller.toggleTasks();
try {
  await runDurableTui(remote.view, remote.controller, SettingsManager.create(process.cwd()));
} finally {
  remote.close();
}
