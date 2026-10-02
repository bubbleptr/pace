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
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Layout, LayoutContent, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Markdown } from "@astryxdesign/core/Markdown";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import type { AgentState } from "@earendil-works/pi-durable";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { type ChatItem, chatItems, queueItems, statusText, taskRows } from "../presentation/chat.ts";
import type { RemoteDurable } from "../protocol/remote-durable.ts";
import { isBusy } from "../protocol/transcript.ts";
import type { DurableView } from "../protocol/view.ts";
import { addressFromHash } from "./address.ts";
import { useDurableView, useRemoteDurable } from "./use-remote.ts";

const page: CSSProperties = { height: "100dvh", width: "100%" };
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

function Centered({ children }: { children: ReactNode }) {
  return (
    <VStack style={page} hAlign="center" vAlign="center" padding={6}>
      {children}
    </VStack>
  );
}

function Connected({ address }: { address: { url: string; token: string } }) {
  const state = useRemoteDurable(address);
  if (state.status === "connecting") {
    return (
      <Centered>
        <EmptyState title="Connecting" description={address.url} />
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
  return (
    <VStack style={page}>
      <Layout
        height="fill"
        start={<ConversationNav view={view} remote={remote} />}
        content={
          <LayoutContent padding={0}>
            <VStack height="100%">
              <ConnectionBanner view={view} />
              <ChatLayout
                style={chatColumn}
                composer={<Composer view={view} remote={remote} busy={busy} />}
                emptyState={<EmptyState title="Nothing here yet" description="Ask the agent something. Every client sees it." />}
              >
                {items.length === 0 ? null : (
                  <ChatMessageList isStreaming={busy}>
                    {items.map((item) => (
                      <ChatRow key={item.id} item={item} />
                    ))}
                  </ChatMessageList>
                )}
              </ChatLayout>
            </VStack>
          </LayoutContent>
        }
        end={
          <LayoutPanel width={320} hasDivider padding={3} label="Live state">
            <LiveState view={view} />
          </LayoutPanel>
        }
      />
    </VStack>
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
  const shown = view.conversation.conversation.id;
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
      <SideNavSection title="Conversations">
        {[...view.conversations].map((summary) => (
          <SideNavItem
            key={summary.id}
            label={summary.title === undefined ? summary.label : `${summary.label} · ${summary.title}`}
            isSelected={summary.id === shown}
            onClick={() => void remote.controller.switchConversation(summary.id)}
          />
        ))}
      </SideNavSection>
    </SideNav>
  );
}

function ChatRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <ChatMessage sender="user">
          <ChatMessageBubble>{item.text}</ChatMessageBubble>
        </ChatMessage>
      );
    case "assistant":
      return (
        <ChatMessage sender="assistant">
          {item.text === "" ? null : (
            <ChatMessageBubble
              variant="ghost"
              metadata={item.stopReason === "aborted" ? <Token label="interrupted" color="orange" size="sm" /> : undefined}
            >
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
    case "compaction":
      return <ChatSystemMessage variant="divider">Earlier context summarized</ChatSystemMessage>;
    case "reset":
      return <ChatSystemMessage variant="divider">New context</ChatSystemMessage>;
  }
}

function Composer({ view, remote, busy }: { view: DurableView; remote: RemoteDurable; busy: boolean }) {
  const [value, setValue] = useState("");
  const agent = agentOf(view);
  const model = agent.model === undefined ? "No model" : `${agent.model.provider}/${agent.model.modelId}`;
  const status = statusText(view.conversation);
  return (
    <ChatComposer
      value={value}
      onChange={setValue}
      // Enter prompts when idle and steers when busy, as in the TUI.
      onSubmit={(text) => void remote.controller.submit(text, "steer")}
      isStopShown={busy}
      onStop={() => void remote.controller.abort()}
      isDisabled={view.connection !== "connected"}
      placeholder={busy ? "Steer the running turn…" : "Ask the agent…"}
      headerContext={status === "" ? undefined : <Text type="supporting">{status}</Text>}
      footerActions={
        <>
          <DropdownMenu
            button={{ label: model, variant: "ghost", size: "sm" }}
            items={view.models.map((candidate) => ({
              label: `${candidate.provider}/${candidate.modelId}`,
              onClick: () => void remote.controller.setModel({ provider: candidate.provider, modelId: candidate.modelId }),
            }))}
          />
          <Button
            label={`Thinking: ${agent.thinkingLevel ?? "off"}`}
            variant="ghost"
            size="sm"
            onClick={() => void remote.controller.cycleThinking()}
          />
          <Button label="Compact" variant="ghost" size="sm" onClick={() => void remote.controller.compact(undefined)} />
        </>
      }
      sendActions={
        <Button
          label="Follow-up"
          variant="ghost"
          size="sm"
          tooltip="Queue after the running turn"
          isDisabled={value.trim() === ""}
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
  return (
    <VStack gap={4}>
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
    </VStack>
  );
}
