// Settings → MCP: manage the global Pi mcp.json through the backend's
// `pi mcp` bridge. The config list renders instantly; connection states come
// from a separate probe query that can take as long as a server's timeout.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Selector, SelectorOption } from "@astryxdesign/core/Selector";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useState } from "react";
import { MoreHorizontal, RefreshCw } from "@/shared/ui/icons";
import { invoke } from "@/shared/runtime";
import type {
  McpActionResult,
  McpAddServerInput,
  McpConfigReport,
  McpExposure,
  McpProbeReport,
  McpServerConfigItem,
  McpServerProbe,
} from "@pace/core";

const MCP_CONFIG_KEY = ["mcp-config"] as const;
const MCP_PROBE_KEY = ["mcp-probe"] as const;

const EXPOSURE_OPTIONS: Array<{ value: McpExposure; description: string }> = [
  { value: "codemode", description: "Called from codemode scripts, listed in its description" },
  { value: "codemode-deferred", description: "Called from codemode scripts, found with searchTools()" },
  { value: "deferred", description: "Loaded by tool_search, then called directly" },
  { value: "direct", description: "Declared to the model like built-in tools" },
  { value: "hidden", description: "Registered but unreachable" },
];

type RowStatus = {
  variant: StatusDotVariant;
  label: string;
  pulsing?: boolean;
};

function rowStatus(
  server: McpServerConfigItem,
  probe: McpServerProbe | undefined,
  probeFailed: boolean,
): RowStatus {
  if (!server.enabled) {
    return { variant: "neutral", label: "Disabled" };
  }
  if (probe) {
    switch (probe.state) {
      case "connected":
        return { variant: "success", label: "Connected" };
      case "needs-auth":
        return { variant: "warning", label: "Needs sign-in" };
      case "failed":
        return { variant: "error", label: "Failed" };
      case "disabled":
        return { variant: "neutral", label: "Disabled" };
      case "connecting":
        return { variant: "neutral", label: "Connecting…", pulsing: true };
      case "disconnected":
        return { variant: "neutral", label: "Disconnected" };
    }
  }
  if (probeFailed) {
    return { variant: "neutral", label: "Status unknown" };
  }
  return { variant: "neutral", label: "Checking…", pulsing: true };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function McpServerTools({ tools }: { tools: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      trigger={
        <Text type="body" size="sm" color="secondary">
          {`${tools.length} tool${tools.length === 1 ? "" : "s"}`}
        </Text>
      }
      isOpen={open}
      onOpenChange={setOpen}
    >
      {open ? (
        <Text
          as="div"
          type="body"
          size="sm"
          style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {tools.join(", ")}
        </Text>
      ) : null}
    </Collapsible>
  );
}

function McpExposureSelect({
  label,
  value,
  disabled,
  isLabelHidden = true,
  onChange,
}: {
  label: string;
  value: McpExposure;
  disabled?: boolean;
  /** Rows hide the label; the add dialog shows it like the other fields. */
  isLabelHidden?: boolean;
  onChange: (value: McpExposure) => void;
}) {
  return (
    <Selector
      isLabelHidden={isLabelHidden}
      label={label}
      size="sm"
      options={EXPOSURE_OPTIONS.map((option) => ({
        value: option.value,
        label: option.value,
      }))}
      value={value}
      isDisabled={disabled}
      onChange={(next) => onChange(next as McpExposure)}
      renderOption={(option) => {
        const meta = EXPOSURE_OPTIONS.find((entry) => entry.value === option.value);
        return (
          <SelectorOption
            label={option.label ?? option.value}
            description={meta?.description}
          />
        );
      }}
    />
  );
}

function McpServerRow({
  server,
  probe,
  probeFailed,
}: {
  server: McpServerConfigItem;
  probe?: McpServerProbe;
  probeFailed: boolean;
}) {
  const queryClient = useQueryClient();
  const [rowError, setRowError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const applyConfigReport = (report: McpConfigReport) => {
    queryClient.setQueryData(MCP_CONFIG_KEY, report);
    void queryClient.invalidateQueries({ queryKey: MCP_PROBE_KEY });
  };

  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      invoke<McpConfigReport>("set_mcp_server_enabled", {
        name: server.name,
        enabled,
      }),
    onMutate: () => setRowError(null),
    onSuccess: applyConfigReport,
    onError: (error) => setRowError(errorText(error)),
  });

  const exposureMutation = useMutation({
    mutationFn: (exposure: McpExposure) =>
      invoke<McpConfigReport>("set_mcp_server_exposure", {
        name: server.name,
        exposure,
      }),
    onMutate: () => setRowError(null),
    onSuccess: applyConfigReport,
    onError: (error) => setRowError(errorText(error)),
  });

  const signInMutation = useMutation({
    mutationFn: () => invoke<McpActionResult>("login_mcp_server", { name: server.name }),
    onMutate: () => setRowError(null),
    onSuccess: (result) => {
      if (result.ok) {
        // Stored credentials changed, so the config (not just the probe)
        // decides which OAuth button the row shows next.
        void queryClient.invalidateQueries({ queryKey: MCP_CONFIG_KEY });
        void queryClient.invalidateQueries({ queryKey: MCP_PROBE_KEY });
      } else {
        setRowError(result.message || "Sign-in failed.");
      }
    },
    onError: (error) => setRowError(errorText(error)),
  });

  const signOutMutation = useMutation({
    mutationFn: () => invoke<McpActionResult>("logout_mcp_server", { name: server.name }),
    onMutate: () => setRowError(null),
    onSuccess: (result) => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: MCP_CONFIG_KEY });
        void queryClient.invalidateQueries({ queryKey: MCP_PROBE_KEY });
      } else {
        setRowError(result.message || "Sign-out failed.");
      }
    },
    onError: (error) => setRowError(errorText(error)),
  });

  const removeMutation = useMutation({
    mutationFn: () => invoke<McpActionResult>("remove_mcp_server", { name: server.name }),
    onMutate: () => setRemoveError(null),
    onSuccess: (result) => {
      if (result.ok) {
        setRemoveOpen(false);
        void queryClient.invalidateQueries({ queryKey: MCP_CONFIG_KEY });
        void queryClient.invalidateQueries({ queryKey: MCP_PROBE_KEY });
      } else {
        setRemoveError(result.message || `Could not remove ${server.name}.`);
      }
    },
    onError: (error) => setRemoveError(errorText(error)),
  });

  const status = rowStatus(server, probe, probeFailed);
  const controlsBusy = enabledMutation.isPending || exposureMutation.isPending;
  const oauthBusy = signInMutation.isPending || signOutMutation.isPending;
  const showSignIn = server.usesOAuth && probe?.state === "needs-auth";
  // usesOAuth only describes the config shape (HTTP without an Authorization
  // header); sign-out requires actual stored credentials. When sign-in applies,
  // it takes precedence over offering sign-out for a stale credential.
  const showSignOut =
    server.usesOAuth && server.hasStoredCredentials && !showSignIn;

  return (
    <>
      <ListItem
        data-testid={`mcp-server-${server.name}`}
        label={server.name}
        description={
          <VStack gap={1}>
            <HStack gap={1.5} vAlign="center">
              <StatusDot
                variant={status.variant}
                label={status.label}
                isPulsing={status.pulsing}
              />
              <Text type="supporting">{status.label}</Text>
            </HStack>
            <span title={server.transport}>
              <Text type="supporting" maxLines={1}>
                <Code>{server.transport}</Code>
              </Text>
            </span>
            {probe?.state === "connected" && probe.tools.length > 0 ? (
              <McpServerTools tools={probe.tools} />
            ) : null}
            {probe?.state === "connected" && probe.tools.length === 0 ? (
              <Text type="supporting">No tools</Text>
            ) : null}
            {probe?.state === "failed" && probe.error ? (
              <span title={probe.error}>
                <Text
                  type="supporting"
                  maxLines={1}
                  style={{ color: "var(--danger)" }}
                >
                  {probe.error}
                </Text>
              </span>
            ) : null}
            {rowError ? (
              <Text
                as="p"
                type="supporting"
                role="alert"
                style={{ color: "var(--danger)" }}
              >
                {rowError}
              </Text>
            ) : null}
          </VStack>
        }
        endContent={
          <HStack gap={2} vAlign="center">
            {showSignIn ? (
              <Button
                variant="secondary"
                size="sm"
                label={
                  signInMutation.isPending ? "Waiting for browser…" : "Sign in"
                }
                isDisabled={oauthBusy}
                onClick={() => signInMutation.mutate()}
              />
            ) : null}
            {showSignOut ? (
              <Button
                variant="ghost"
                size="sm"
                label={signOutMutation.isPending ? "Signing out…" : "Sign out"}
                isDisabled={oauthBusy}
                onClick={() => signOutMutation.mutate()}
              />
            ) : null}
            <McpExposureSelect
              label={`${server.name} tool exposure`}
              value={server.exposure}
              disabled={controlsBusy}
              onChange={(exposure) => exposureMutation.mutate(exposure)}
            />
            <Switch
              label={`Enable ${server.name}`}
              isLabelHidden
              value={server.enabled}
              isDisabled={controlsBusy}
              onChange={(enabled) => enabledMutation.mutate(enabled)}
            />
            <MoreMenu
              icon={<MoreHorizontal aria-hidden="true" />}
              label={`${server.name} actions`}
              size="sm"
              variant="ghost"
              isDisabled={removeMutation.isPending}
              items={[
                {
                  label: "Remove…",
                  onClick: () => {
                    setRemoveError(null);
                    setRemoveOpen(true);
                  },
                },
              ]}
            />
          </HStack>
        }
      />
      {removeOpen ? (
        <RemoveMcpServerDialog
          name={server.name}
          pending={removeMutation.isPending}
          error={removeError}
          onConfirm={() => removeMutation.mutate()}
          onClose={() => setRemoveOpen(false)}
        />
      ) : null}
    </>
  );
}

function RemoveMcpServerDialog({
  name,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  name: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      aria-label="Remove MCP server"
      isOpen
      onOpenChange={(isOpen) => {
        if (!isOpen && !pending) onClose();
      }}
      purpose="form"
    >
      <Layout
        header={
          <DialogHeader
            title="Remove MCP server"
            onOpenChange={(isOpen) => {
              if (!isOpen && !pending) onClose();
            }}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={3}>
              <Text as="p">Remove {name} from mcp.json?</Text>
              {error ? (
                <Text
                  as="p"
                  type="supporting"
                  role="alert"
                  style={{ color: "var(--danger)" }}
                >
                  {error}
                </Text>
              ) : null}
              <HStack gap={2} justify="end">
                <Button
                  variant="ghost"
                  label="Cancel"
                  isDisabled={pending}
                  onClick={onClose}
                />
                <Button
                  variant="destructive"
                  label={pending ? "Removing…" : "Remove"}
                  isDisabled={pending}
                  onClick={onConfirm}
                />
              </HStack>
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function AddMcpServerDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [exposure, setExposure] = useState<McpExposure>("codemode");
  const [error, setError] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: (input: McpAddServerInput) =>
      invoke<McpActionResult>("add_mcp_server", { input }),
    onSuccess: (result) => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: MCP_CONFIG_KEY });
        void queryClient.invalidateQueries({ queryKey: MCP_PROBE_KEY });
        onClose();
      } else {
        setError(result.message || "Could not add the server.");
      }
    },
    onError: (err) => setError(errorText(err)),
  });

  // One argument per line; blank lines dropped, inner spaces preserved.
  const args = argsText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const canSubmit =
    name.trim().length > 0 &&
    (kind === "stdio" ? command.trim().length > 0 : url.trim().length > 0) &&
    !addMutation.isPending;

  const submit = () => {
    if (!canSubmit) return;
    setError(null);
    const exposureInput = exposure === "codemode" ? {} : { exposure };
    addMutation.mutate(
      kind === "stdio"
        ? { kind, name: name.trim(), command: command.trim(), args, ...exposureInput }
        : { kind, name: name.trim(), url: url.trim(), ...exposureInput },
    );
  };

  return (
    <Dialog
      aria-label="Add server"
      isOpen
      onOpenChange={(isOpen) => {
        if (!isOpen && !addMutation.isPending) onClose();
      }}
      purpose="form"
    >
      <Layout
        header={
          <DialogHeader
            title="Add server"
            onOpenChange={(isOpen) => {
              if (!isOpen && !addMutation.isPending) onClose();
            }}
          />
        }
        content={
          <LayoutContent>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <VStack gap={3}>
                <TextInput
                  label="Name"
                  value={name}
                  onChange={setName}
                  isDisabled={addMutation.isPending}
                  placeholder="filesystem"
                />
                <SegmentedControl
                  label="Transport"
                  layout="fill"
                  value={kind}
                  onChange={(value) => {
                    if (value === "stdio" || value === "http") setKind(value);
                  }}
                >
                  <SegmentedControlItem label="Stdio" value="stdio" />
                  <SegmentedControlItem label="HTTP" value="http" />
                </SegmentedControl>
                {kind === "stdio" ? (
                  <>
                    <TextInput
                      label="Command"
                      value={command}
                      onChange={setCommand}
                      isDisabled={addMutation.isPending}
                      placeholder="npx"
                    />
                    <TextArea
                      label="Arguments"
                      description="One argument per line."
                      value={argsText}
                      onChange={setArgsText}
                      isDisabled={addMutation.isPending}
                      placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                    />
                  </>
                ) : (
                  <TextInput
                    label="URL"
                    value={url}
                    onChange={setUrl}
                    isDisabled={addMutation.isPending}
                    placeholder="https://example.com/mcp"
                  />
                )}
                <McpExposureSelect
                  label="Exposure"
                  value={exposure}
                  disabled={addMutation.isPending}
                  isLabelHidden={false}
                  onChange={setExposure}
                />
                <Text as="p" type="supporting">
                  Environment variables, headers, and OAuth client settings still
                  need editing mcp.json directly.
                </Text>
                {error ? (
                  <Text
                    as="p"
                    type="supporting"
                    role="alert"
                    style={{ color: "var(--danger)" }}
                  >
                    {error}
                  </Text>
                ) : null}
                <HStack gap={2} justify="end">
                  <Button
                    type="submit"
                    variant="primary"
                    label={addMutation.isPending ? "Adding…" : "Add server"}
                    isDisabled={!canSubmit}
                  />
                </HStack>
              </VStack>
            </form>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

export function McpSettingsSection({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);

  const configQuery = useQuery({
    queryKey: MCP_CONFIG_KEY,
    queryFn: () => invoke<McpConfigReport>("get_mcp_config"),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const probeQuery = useQuery({
    queryKey: MCP_PROBE_KEY,
    queryFn: () => invoke<McpProbeReport>("probe_mcp_servers"),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const servers = configQuery.data?.servers ?? [];
  // A probe in flight means the cached report is stale: a toggled or just
  // signed-in server would flash its old state (e.g. still "Disabled" while
  // enabled) until the new probe lands. Withhold it so rows show "Checking…".
  const probes = probeQuery.isFetching
    ? new Map<string, McpServerProbe>()
    : new Map(
        (probeQuery.data?.servers ?? []).map((server) => [server.name, server]),
      );
  const configErrors = configQuery.data?.errors ?? [];
  const probeErrors = probeQuery.data?.errors ?? [];

  const refresh = () => {
    void configQuery.refetch();
    void probeQuery.refetch();
  };

  return (
    <VStack
      as="section"
      aria-labelledby="settings-mcp-heading"
      gap={3}
      data-testid="settings-mcp"
    >
      <VStack gap={2}>
        <HStack justify="between" vAlign="center">
          <Heading level={2} id="settings-mcp-heading">
            MCP
          </Heading>
          <HStack gap={2} vAlign="center">
            <Button
              variant="ghost"
              size="sm"
              label="Refresh"
              icon={<RefreshCw aria-hidden="true" />}
              isDisabled={configQuery.isFetching || probeQuery.isFetching}
              onClick={refresh}
            />
            <Button
              variant="secondary"
              size="sm"
              label="Add server"
              onClick={() => setAddOpen(true)}
            />
          </HStack>
        </HStack>
        <Text as="p" type="supporting">
          MCP servers from the global Pi <Code>mcp.json</Code>. Changes apply to
          new sessions. Sign-ins reach running sessions on their next turn.
        </Text>
        {configQuery.data ? (
          <Text as="p" type="supporting">
            <Code style={{ userSelect: "text" }}>
              {configQuery.data.configPath}
            </Code>
          </Text>
        ) : null}
      </VStack>

      {configErrors.length > 0 ? (
        <Banner
          status="error"
          title="mcp.json has configuration errors"
          description={configErrors.join("\n")}
        />
      ) : null}
      {probeErrors.length > 0 ? (
        <Banner
          status="error"
          title="Server check reported errors"
          description={probeErrors.join("\n")}
        />
      ) : null}
      {configQuery.isError ? (
        <Banner
          status="error"
          title="Could not load MCP configuration"
          description={errorText(configQuery.error)}
        />
      ) : null}
      {probeQuery.isError ? (
        <Banner
          status="error"
          title="Could not check server status"
          description={errorText(probeQuery.error)}
          endContent={
            <Button
              variant="secondary"
              size="sm"
              label="Retry"
              onClick={() => void probeQuery.refetch()}
            />
          }
        />
      ) : null}

      {configQuery.isPending ? (
        <Text as="p" type="supporting">
          Loading…
        </Text>
      ) : servers.length === 0 ? (
        <EmptyState
          isCompact
          title="No MCP servers configured"
          description="Add a server to mcp.json to give Pi extra tools."
          actions={
            <Button
              variant="secondary"
              size="sm"
              label="Add server"
              onClick={() => setAddOpen(true)}
            />
          }
        />
      ) : (
        <List hasDividers>
          {servers.map((server) => (
            <McpServerRow
              key={server.name}
              server={server}
              probe={probes.get(server.name)}
              probeFailed={probeQuery.isError && !probeQuery.isFetching}
            />
          ))}
        </List>
      )}

      {addOpen ? <AddMcpServerDialog onClose={() => setAddOpen(false)} /> : null}
    </VStack>
  );
}
