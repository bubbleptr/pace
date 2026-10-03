import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack, Layout, LayoutContent, LayoutFooter, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Markdown } from "@astryxdesign/core/Markdown";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import type { AgentState } from "@earendil-works/pi-durable";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { approvalText, type ChatItem, chatItems, planItems, queueItems, statusText, taskRows, usageRows } from "../presentation/chat.ts";
import type { RemoteDurable, RemoteDurableOptions } from "../protocol/remote-durable.ts";
import { isBusy } from "../protocol/transcript.ts";
import type { DurableView } from "../protocol/view.ts";
import { addressFromHash } from "./address.ts";
import { useDurableView, useRemoteDurable } from "./use-remote.ts";

const page: CSSProperties = {
  height: "100dvh",
  width: "100%",
  backgroundColor: "var(--color-background-body)",
  color: "var(--color-text-primary)",
};
const chatColumn: CSSProperties = { flex: 1, minHeight: 0 };

export function App() {
  const address = useMemo(() => addressFromHash(window.location.hash), []);
  if (address === undefined) {
    return (
      <Centered>
        <EmptyState title="No host token" description="Open the link the host printed: http://127.0.0.1:5199/#token=…" />
      </Centered>
    );
  }
  return <Connected address={address} />;
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <VStack style={page} hAlign="center" vAlign="center" padding={6}>
      {children}
    </VStack>
  );
}

function Connected({ address }: { address: { url: string; token: string } }) {
  return <RemoteWorkbench options={{ ...address, clientName: "web" }} connectionKey={`${address.url} ${address.token}`} label={address.url} />;
}

/** Connects with `options` and shows the workbench, or why it cannot; shared by this page and Pace's dev page. */
export function RemoteWorkbench({ options, connectionKey, label }: { options: RemoteDurableOptions; connectionKey: string; label: string }) {
  const state = useRemoteDurable(options, connectionKey);
  if (state.status === "connecting") {
    return (
      <Centered>
        <EmptyState title="Connecting" description={label} />
      </Centered>
    );
  }
  if (state.status === "failed") {
    return (
      <Centered>
        <Banner status="error" title="Could not connect to the host" description={state.error} />
      </Centered>
    );
  }
  return <Workbench remote={state.remote} />;
}

const agentOf = (view: DurableView): AgentState => (view.conversation.docs["pi.agent"] ?? {}) as AgentState;

function Workbench({ remote }: { remote: RemoteDurable }) {
  const view = useDurableView(remote);
  const items = useMemo(() => chatItems(view.conversation), [view.conversation]);
  const busy = isBusy(view.conversation);
  // Below this the chat column would be squeezed; the live state moves into a dialog.
  const narrow = useMediaQuery("(max-width: 1023px)");
  const [navOpen, setNavOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [forkAt, setForkAt] = useState<string>();
  return (
    <VStack style={page}>
      <Layout
        height="fill"
        start={narrow ? undefined : <ConversationNav view={view} remote={remote} />}
        content={
          <LayoutContent padding={0}>
            <VStack height="100%">
              {narrow ? (
                <HStack padding={2} gap={2} hAlign="between">
                  <Button label="Conversations" variant="ghost" onClick={() => setNavOpen(true)} />
                  <Button label="Live state" variant="ghost" onClick={() => setPanelOpen(true)} />
                </HStack>
              ) : null}
              <ConnectionBanner view={view} />
              <ApprovalBanners view={view} remote={remote} />
              <ChatLayout
                style={chatColumn}
                composer={<Composer view={view} remote={remote} busy={busy} narrow={narrow} />}
                emptyState={<EmptyState title="Nothing here yet" description="Ask the agent something. Every client sees it." />}
              >
                {items.length === 0 ? null : (
                  <ChatMessageList isStreaming={busy}>
                    {items.map((item) => (
                      <ChatRow key={item.id} item={item} onFork={setForkAt} connected={view.connection === "connected"} />
                    ))}
                  </ChatMessageList>
                )}
              </ChatLayout>
            </VStack>
          </LayoutContent>
        }
        end={
          narrow ? undefined : (
            <LayoutPanel width={320} hasDivider padding={3} label="Live state">
              <LiveState view={view} />
            </LayoutPanel>
          )
        }
      />
      {narrow ? (
        <MobileNav isOpen={navOpen} onOpenChange={setNavOpen} header="Conversations">
          <ConversationItems view={view} remote={remote} onSelect={() => setNavOpen(false)} />
        </MobileNav>
      ) : null}
      {narrow ? (
        <Dialog isOpen={panelOpen} onOpenChange={setPanelOpen} width={360}>
          <Layout
            header={<DialogHeader title="Live state" onOpenChange={setPanelOpen} />}
            content={
              <LayoutContent>
                <LiveState view={view} />
              </LayoutContent>
            }
          />
        </Dialog>
      ) : null}
      {forkAt === undefined ? null : (
        <ForkDialog entryId={forkAt} remote={remote} connected={view.connection === "connected"} onClose={() => setForkAt(undefined)} />
      )}
    </VStack>
  );
}

/** One banner per held tool call, on every client at once; whichever client decides first wins. */
function ApprovalBanners({ view, remote }: { view: DurableView; remote: RemoteDurable }) {
  return view.approvals.map((approval) => (
    <Banner
      key={approval.id}
      status="warning"
      container="section"
      title={`Approve ${approval.tool}?`}
      description={approvalText(approval, view.conversations)}
      endContent={
        <HStack gap={2}>
          <Button label="Deny" variant="secondary" isDisabled={view.connection !== "connected"} onClick={() => void remote.controller.approve(approval, false)} />
          <Button label="Approve" variant="primary" isDisabled={view.connection !== "connected"} onClick={() => void remote.controller.approve(approval, true)} />
        </HStack>
      }
    />
  ));
}

function ForkDialog({ entryId, remote, connected, onClose }: { entryId: string; remote: RemoteDurable; connected: boolean; onClose: () => void }) {
  const [prompt, setPrompt] = useState("Write the postmortem for the v2.3 incident.");
  const fork = (): void => {
    void remote.controller.fork(entryId, prompt.trim(), ["rollback"]);
    onClose();
  };
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title="Fork from this answer"
            subtitle="The fork sees the conversation up to here and runs without the rollback tool."
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            <TextInput label="First message" value={prompt} onChange={setPrompt} />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label="Fork" variant="primary" isDisabled={!connected || prompt.trim() === ""} onClick={fork} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

function ConnectionBanner({ view }: { view: DurableView }) {
  if (view.connection === "reconnecting") {
    return (
      <Banner
        status="warning"
        container="section"
        title="Host connection lost"
        description="Reconnecting… the view keeps the last state the host sent."
      />
    );
  }
  if (view.connection === "closed") return <Banner status="error" container="section" title="Disconnected from the host" />;
  return null;
}

function ConversationNav({ view, remote }: { view: DurableView; remote: RemoteDurable }) {
  const connection =
    view.connection === "connected" ? (
      <StatusDot variant="success" label="Connected" tooltip="Connected to the host" />
    ) : (
      <StatusDot variant={view.connection === "closed" ? "error" : "warning"} label={view.connection} tooltip={view.connection} isPulsing />
    );
  return (
    <SideNav
      header={<SideNavHeading heading="Durable host" subheading={view.session.id} headerEndContent={connection} />}
      footer={<Text type="supporting" maxLines={1}>{view.session.cwd}</Text>}
    >
      <ConversationItems view={view} remote={remote} />
    </SideNav>
  );
}

function ConversationItems({ view, remote, onSelect }: { view: DurableView; remote: RemoteDurable; onSelect?: () => void }) {
  const shown = view.conversation.conversation.id;
  return (
    <SideNavSection title="Conversations">
      {view.conversations.map((summary) => (
        <SideNavItem
          key={summary.id}
          label={summary.title === undefined ? summary.label : `${summary.label} · ${summary.title}`}
          isSelected={summary.id === shown}
          isDisabled={view.connection !== "connected"}
          onClick={() => {
            void remote.controller.switchConversation(summary.id);
            onSelect?.();
          }}
        />
      ))}
    </SideNavSection>
  );
}

function ChatRow({ item, onFork, connected }: { item: ChatItem; onFork: (entryId: string) => void; connected: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <ChatMessage sender="user">
          <ChatMessageBubble>{item.text}</ChatMessageBubble>
        </ChatMessage>
      );
    case "assistant": {
      const interrupted = item.stopReason === "aborted";
      // Only a settled answer is an entry a fork can start from.
      const forkable = !item.streaming && !interrupted;
      return (
        <ChatMessage
          sender="assistant"
          metadata={
            interrupted ? (
              <Token label="interrupted" color="orange" size="sm" />
            ) : forkable ? (
              <Button label="Fork" variant="ghost" size="sm" isDisabled={!connected} tooltip="Continue from here in a new conversation" onClick={() => onFork(item.id)} />
            ) : undefined
          }
        >
          {item.thinking === undefined ? null : (
            <Collapsible trigger={<Text type="supporting">{item.streaming && item.text === "" ? "Thinking…" : "Thinking"}</Text>} defaultIsOpen={false}>
              <Markdown density="compact">{item.thinking}</Markdown>
            </Collapsible>
          )}
          {item.text === "" ? null : (
            <ChatMessageBubble variant="ghost">
              <Markdown density="compact" isStreaming={item.streaming}>
                {item.text}
              </Markdown>
            </ChatMessageBubble>
          )}
          {item.tools.length === 0 ? null : (
            <ChatToolCalls
              calls={item.tools.map((tool) => ({
                key: tool.callId,
                name: tool.name,
                status: tool.status,
                ...(tool.conversationId !== undefined
                  ? { target: `subagent ${tool.conversationId}` }
                  : tool.target === undefined
                    ? {}
                    : { target: tool.target }),
                ...(tool.status === "error" && tool.output !== undefined ? { errorMessage: tool.output } : {}),
                ...(tool.status !== "error" && tool.output !== undefined
                  ? { resultDetail: <Markdown density="compact">{`\`\`\`\n${tool.output}\n\`\`\``}</Markdown> }
                  : {}),
              }))}
            />
          )}
        </ChatMessage>
      );
    }
    case "compaction":
      return <ChatSystemMessage variant="divider">Earlier context summarized</ChatSystemMessage>;
    case "reset":
      return <ChatSystemMessage variant="divider">New context</ChatSystemMessage>;
  }
}

function Composer({
  view,
  remote,
  busy,
  narrow,
}: {
  view: DurableView;
  remote: RemoteDurable;
  busy: boolean;
  narrow: boolean;
}) {
  const [value, setValue] = useState("");
  const agent = agentOf(view);
  const model = agent.model === undefined ? "No model" : `${agent.model.provider}/${agent.model.modelId}`;
  const status = statusText(view.conversation);
  const disconnected = view.connection !== "connected";
  const models = view.models.map((candidate) => ({
    label: `${candidate.provider}/${candidate.modelId}`,
    onClick: () => void remote.controller.setModel({ provider: candidate.provider, modelId: candidate.modelId }),
  }));
  return (
    <ChatComposer
      value={value}
      onChange={setValue}
      // Enter prompts when idle and steers when busy, as in the TUI.
      onSubmit={(text) => void remote.controller.submit(text, "steer")}
      isStopShown={busy && value.trim() === ""}
      onStop={() => void remote.controller.abort()}
      isDisabled={disconnected}
      placeholder={busy ? "Steer the running turn…" : "Ask the agent…"}
      headerContext={status === "" ? undefined : <Text type="supporting">{status}</Text>}
      footerActions={
        narrow ? (
          <DropdownMenu
            button={{ label: "Controls", variant: "ghost", isDisabled: disconnected }}
            items={[
              { label: `Thinking: ${agent.thinkingLevel ?? "off"}`, onClick: () => void remote.controller.cycleThinking() },
              { label: "Compact", onClick: () => void remote.controller.compact(undefined) },
              { type: "section", title: `Model: ${model}`, items: models },
            ]}
          />
        ) : (
          <>
            <DropdownMenu
              button={{ label: model, variant: "ghost", size: "sm", isDisabled: disconnected }}
              items={models}
            />
            <Button
              label={`Thinking: ${agent.thinkingLevel ?? "off"}`}
              variant="ghost"
              size="sm"
              isDisabled={disconnected}
              onClick={() => void remote.controller.cycleThinking()}
            />
            <Button label="Compact" variant="ghost" size="sm" isDisabled={disconnected} onClick={() => void remote.controller.compact(undefined)} />
          </>
        )
      }
      sendActions={
        <Button
          label="Follow-up"
          variant="ghost"
          size={narrow ? "md" : "sm"}
          tooltip="Queue after the running turn"
          isDisabled={disconnected || value.trim() === ""}
          onClick={() => {
            void remote.controller.submit(value.trim(), "followUp");
            setValue("");
          }}
        />
      }
    />
  );
}

function LiveState({ view }: { view: DurableView }) {
  const rows = view.tasks === undefined ? [] : taskRows(view.tasks);
  const queue = queueItems(view.conversation);
  const notices = [...view.notices].reverse().slice(0, 5);
  const plan = planItems(view.docs);
  const usage = usageRows(view.conversation);
  return (
    <VStack gap={4}>
      {plan.length === 0 ? null : (
        <List density="compact" header={<Text type="label" weight="semibold">Plan</Text>}>
          {plan.map((item) => (
            <ListItem key={item.text} label={item.text} startContent={<Token label={item.status} size="sm" {...(item.status === "done" ? { color: "green" } : {})} />} />
          ))}
        </List>
      )}
      <List density="compact" header={<Text type="label" weight="semibold">Tasks</Text>}>
        {rows.length === 0 ? (
          <ListItem label="No live tasks" />
        ) : (
          rows.map((row) => <ListItem key={row.id} label={`${"\u00a0\u00a0".repeat(row.depth)}${row.depth > 0 ? "└ " : ""}${row.label}`} />)
        )}
      </List>
      <List density="compact" header={<Text type="label" weight="semibold">Queue</Text>}>
        {queue.length === 0 ? (
          <ListItem label="Empty" />
        ) : (
          queue.map((item) => <ListItem key={item.id} label={item.text} startContent={<Token label={item.mode} size="sm" />} />)
        )}
      </List>
      {notices.length === 0 ? null : (
        <List density="compact" header={<Text type="label" weight="semibold">Notices</Text>}>
          {notices.map((notice) => (
            <ListItem
              key={notice.id}
              label={notice.message}
              startContent={
                <StatusDot variant={notice.level === "error" ? "error" : notice.level === "warning" ? "warning" : "neutral"} label={notice.level} />
              }
            />
          ))}
        </List>
      )}
      {usage.length === 0 ? null : (
        <List density="compact" header={<Text type="label" weight="semibold">Usage</Text>}>
          {usage.map((row) => (
            <ListItem key={row.key} label={row.key} description={`↑${row.input} ↓${row.output} · $${row.cost.toFixed(4)}`} />
          ))}
        </List>
      )}
    </VStack>
  );
}
