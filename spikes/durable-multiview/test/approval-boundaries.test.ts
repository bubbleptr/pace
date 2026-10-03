import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, it } from "vitest";
import { ApprovalsDoc } from "../host/demo/state.ts";
import { connectTo, startDemoHost, useCleanups, waitForView } from "./support.ts";

const defer = useCleanups();
const context = BACKGROUND_CONTEXT;

it("rejects an approval for another conversation without releasing the original tool", async () => {
  const { host, demo } = await startDemoHost(defer);
  const client = await connectTo(defer, host);
  const other = await host.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  await client.controller.submit("roll back to v2.2", "followUp");
  await waitForView(client.view, (view) => view.approvals.length === 1);
  const approval = client.view.current().approvals[0]!;
  const board = demo.hostOptions.approvals!;

  await expect(board.decide(other.id, approval.id, true, "web")).rejects.toThrow(/conversation/i);
  expect(board.value).toContainEqual(approval);
  expect((await host.harness.snapshot(ApprovalsDoc, other.id, context))?.decisions[approval.id]).toBeUndefined();
  expect((await host.harness.snapshot(ApprovalsDoc, approval.conversationId, context))?.decisions[approval.id]).toBeUndefined();

  const denied = await board.decide(approval.conversationId, approval.id, false, "tui");
  expect(denied).toMatchObject({ first: true, decision: { approved: false, by: "tui" } });
  expect(await board.decide(approval.conversationId, approval.id, true, "web")).toMatchObject({
    first: false,
    decision: { approved: false, by: "tui" },
  });
  await expect(board.decide(other.id, approval.id, true, "web")).rejects.toThrow();
  expect((await host.harness.snapshot(ApprovalsDoc, other.id, context))?.decisions[approval.id]).toBeUndefined();
});

it.each([false, true])("rejects a foreign stored decision after cancellation (restart: %s)", async (restart) => {
  let { host, demo } = await startDemoHost(defer);
  const client = await connectTo(defer, host);
  const other = await host.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  await client.controller.submit("roll back to v2.2", "followUp");
  await waitForView(client.view, (view) => view.approvals.length === 1);
  const approval = client.view.current().approvals[0]!;
  await client.controller.abort();
  await waitForView(client.view, (view) => view.approvals.length === 0);

  // Earlier hosts could persist a decision under the wrong conversation before checking ownership.
  await host.harness.commit(async (tx) => {
    (await tx.doc(ApprovalsDoc, other.id)).decisions[approval.id] = { approved: true, by: "other", at: 1 };
  }, context);
  if (restart) {
    const dataDir = client.view.current().session.directory;
    client.close();
    await host.close();
    ({ host, demo } = await startDemoHost(defer, { dataDir }));
  }

  const board = demo.hostOptions.approvals!;
  await expect(board.decide(other.id, approval.id, true, "retry")).rejects.toThrow(/conversation/i);
  await expect(board.decide(approval.conversationId, approval.id, true, "owner")).rejects.toThrow(/No pending approval/);
  expect((await host.harness.snapshot(ApprovalsDoc, approval.conversationId, context))?.decisions[approval.id]).toBeUndefined();
});
