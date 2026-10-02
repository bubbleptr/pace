#!/usr/bin/env node
// A line-mode client of a running host: prints the shown conversation as it
// streams, and sends each typed line. Run several to watch one host from many terminals.
//
//   node cli/observe.ts [--data-dir DIR | --token T] [--url ws://127.0.0.1:7420]
//   typed lines: text (prompt; follow-up while busy), /steer text, /abort, /tasks, /quit
import { createInterface } from "node:readline";
import { connectRemoteDurable } from "../protocol/remote-durable.ts";
import type { DurableView } from "../protocol/view.ts";
import { hostAddress } from "./host-address.ts";
import { initialPrinter, printIncrement } from "./printer.ts";

const address = await hostAddress(process.argv.slice(2));
const remote = await connectRemoteDurable(address);
let printer = initialPrinter;
let shown: DurableView | undefined;
const render = (): void => {
  const view = remote.view.current();
  if (shown !== undefined && view.connection !== shown.connection) process.stdout.write(`\n[${view.connection}]\n`);
  for (const notice of view.notices.slice(shown === undefined ? 0 : shown.notices.length)) {
    process.stdout.write(`\n[${notice.level}] ${notice.message}\n`);
  }
  if (view.tasks !== shown?.tasks && view.tasks !== undefined) {
    const nodes = Object.values(view.tasks.tasks).map((task) => `${task.id}:${task.kind}(${task.state.status})`);
    process.stdout.write(`\n[tasks] ${nodes.length === 0 ? "none" : nodes.join(" ")}\n`);
  }
  shown = view;
  const step = printIncrement(printer, view.conversation);
  printer = step.state;
  process.stdout.write(step.output);
};
remote.view.subscribe(render);
process.stdout.write(`[connected to ${address.url}, session ${remote.view.current().session.id}]\n`);
render();

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const text = line.trim();
  if (text === "") continue;
  if (text === "/quit") break;
  if (text === "/abort") await remote.controller.abort();
  else if (text === "/tasks") await remote.controller.toggleTasks();
  else if (text.startsWith("/steer ")) await remote.controller.submit(text.slice("/steer ".length), "steer");
  else await remote.controller.submit(text, "followUp");
}
remote.close();
