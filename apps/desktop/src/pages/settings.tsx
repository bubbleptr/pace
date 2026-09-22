import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import {
  CheckboxList,
  CheckboxListItem,
} from "@astryxdesign/core/CheckboxList";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { useCallback, useEffect, type ReactNode, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutPanel } from "@astryxdesign/core/Layout";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { SideNav, SideNavItem } from "@astryxdesign/core/SideNav";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import {
  useSettingsDialog,
  type SettingsSection,
} from "@/shared/settings-navigation";
import {
  AnimatedFile,
  AnimatedInformationCircle,
  AnimatedKey,
  AnimatedMessage,
  AnimatedRobot,
  MoreHorizontal,
  RefreshCw,
} from "@/shared/ui/icons";
import { ChangelogSection } from "@/pages/settings-changelog";
import paceIcon from "../../../../build/icon-512.png";
import { ProviderIcon } from "@/entities/provider/provider-icon";
import { invalidateCachedModelCatalog } from "@/entities/model/model-catalog-cache";
import { formatTimestamp } from "@/entities/session/sessions";
import { providerAuthStatusQueryKey } from "@/entities/session/use-provider-auth-status";
import {
  getVisibleModels,
  saveVisibleModels,
} from "@/entities/model/visible-models";
import { useUpdateStatus } from "@/entities/update/use-update-status";
import { isModelVisible } from "@/shared/ui/model-selector/model-selector-logic";
import { invoke, revealProjectInFinder } from "@/shared/runtime";
import type { UpdateStatus } from "@/shared/update-protocol";
import type {
  ModelCatalogRefreshResult,
  ProviderAuthId,
  ProviderAuthStatusItem,
  ProviderAuthStatusReport,
  ProviderConnectionTestResult,
  ProviderFailureKind,
  RuntimeModelCapability,
  RuntimeModelControls,
} from "@pace/core";

const availableModelControlsQueryKey = ["available-model-controls"] as const;

// TanStack's mutation isPending follows only the latest call. A refresh that
// started earlier can still be running after that flag flips false, which
// re-enables Refresh models on top of an open request. This list is the
// disable signal: non-force callers join the request already in flight.
let inFlightCatalogRefreshes: Array<{ promise: Promise<ModelCatalogRefreshResult> }> = [];
const catalogRefreshListeners = new Set<() => void>();

function notifyCatalogRefreshListeners() {
  for (const listener of catalogRefreshListeners) listener();
}

function subscribeCatalogRefreshBusy(listener: () => void) {
  catalogRefreshListeners.add(listener);
  return () => {
    catalogRefreshListeners.delete(listener);
  };
}

function isCatalogRefreshBusy() {
  return inFlightCatalogRefreshes.length > 0;
}

export function resetCatalogRefreshGate() {
  inFlightCatalogRefreshes = [];
  notifyCatalogRefreshListeners();
}

export function startCatalogRefresh(
  force: boolean,
  execute: () => Promise<ModelCatalogRefreshResult>,
): Promise<ModelCatalogRefreshResult> {
  if (!force) {
    const current = inFlightCatalogRefreshes[0];
    if (current) return current.promise;
  }

  const promise = execute().finally(() => {
    inFlightCatalogRefreshes = inFlightCatalogRefreshes.filter(
      (entry) => entry.promise !== promise,
    );
    notifyCatalogRefreshListeners();
  });
  inFlightCatalogRefreshes = [...inFlightCatalogRefreshes, { promise }];
  notifyCatalogRefreshListeners();
  return promise;
}

type AuthTab = "subscription" | "api_key";

async function listProviderAuthStatus() {
  return invoke<ProviderAuthStatusReport>("list_provider_auth_status");
}

function statusSummary(provider: ProviderAuthStatusItem) {
  if (!provider.configured || provider.mode === "none") {
    return "Not configured";
  }

  if (provider.mode === "oauth") {
    return provider.statusLabel
      ? `Subscription · ${provider.statusLabel}`
      : "Subscription connected";
  }

  if (provider.mode === "api_key") {
    return provider.keyHint
      ? `API key · ${provider.keyHint}`
      : "API key configured";
  }

  return "Configured";
}

function connectionEpochKey(providerId: string) {
  return ["provider-connection-epoch", providerId] as const;
}

function bumpProviderConnectionEpoch(queryClient: QueryClient, providerId: string) {
  queryClient.setQueryData<number>(connectionEpochKey(providerId), (current) => (current ?? 0) + 1);
}

type ConnectionTone = "success" | "warning" | "danger";

type ConnectionStatus = {
  tone?: ConnectionTone;
  label: string;
  /** Model and latency: useful when debugging, noise on the card. */
  title?: string;
  /** Raw provider text, shown only behind Details. */
  detail?: string;
  needsSignIn?: boolean;
};

const FAILURE_STATUS: Record<
  ProviderFailureKind,
  (mode: ProviderAuthStatusItem["mode"]) => Pick<ConnectionStatus, "tone" | "label" | "needsSignIn">
> = {
  auth: (mode) =>
    mode === "oauth"
      ? { tone: "warning", label: "Sign-in expired", needsSignIn: true }
      : { tone: "warning", label: "API key rejected" },
  entitlement: () => ({ tone: "warning", label: "Not covered by your plan" }),
  network: () => ({ tone: "danger", label: "Can't reach provider" }),
  unknown: () => ({ tone: "danger", label: "Check failed" }),
};

function connectionStatus(
  provider: ProviderAuthStatusItem,
  check: ProviderConnectionCheck,
): ConnectionStatus {
  // While a check runs the button carries the progress; the line keeps what
  // is currently known instead of repeating "Checking…".
  if (check.transportError) {
    return { tone: "danger", label: "Check failed", detail: check.transportError };
  }
  const result = check.result;
  // Never checked: the credential summary is the whole story.
  if (!result) return { label: statusSummary(provider) };
  if (result.ok) {
    return {
      tone: "success",
      label: "Working",
      title: `${result.modelId} · ${result.latencyMs} ms`,
    };
  }
  return {
    ...FAILURE_STATUS[result.kind](provider.mode),
    title: [result.message, result.modelId].filter(Boolean).join(" · "),
    detail: result.detail || undefined,
  };
}

type ProviderConnectionCheck = {
  result?: ProviderConnectionTestResult;
  checking: boolean;
  transportError?: string;
  run: () => void;
};

function useProviderConnectionCheck(providerId: string): ProviderConnectionCheck {
  const epochQuery = useQuery({
    queryKey: connectionEpochKey(providerId),
    queryFn: () => 0,
    initialData: 0,
    // Epoch only moves when a credential write bumps it. Do not refetch it back to 0.
    enabled: false,
    staleTime: Infinity,
  });
  const epoch = epochQuery.data ?? 0;
  const query = useQuery({
    queryKey: ["provider-connection-test", providerId, epoch],
    queryFn: () =>
      invoke<ProviderConnectionTestResult>("test_provider_connection", {
        providerId,
      }),
    // The result is an explicit probe, not something Settings should fetch on open.
    enabled: false,
    retry: false,
    staleTime: Infinity,
  });
  const { refetch } = query;
  const run = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    result: query.data,
    checking: query.isFetching,
    transportError:
      !query.isFetching && query.isError
        ? query.error instanceof Error
          ? query.error.message
          : "Connection test failed"
        : undefined,
    run,
  };
}

function ProviderStatusLine({ status }: { status: ConnectionStatus }) {
  return (
    <HStack gap={1.5} vAlign="center" data-testid="provider-connection-status">
      {status.tone ? (
        <span
          aria-hidden="true"
          style={{
            inlineSize: 6,
            blockSize: 6,
            borderRadius: "var(--radius-full)",
            background: `var(--${status.tone})`,
            flexShrink: 0,
          }}
        />
      ) : null}
      <span title={status.title}>
        <Text as="p" type="supporting">
          {status.label}
        </Text>
      </span>
    </HStack>
  );
}

function ProviderStatusDetails({ detail }: { detail?: string }) {
  const [open, setOpen] = useState(false);
  if (!detail) return null;
  return (
    <Collapsible
      trigger={<Text type="body" size="sm" color="secondary">Details</Text>}
      isOpen={open}
      onOpenChange={setOpen}
    >
      {open ? (
        <Text as="div" type="body" size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {detail}
        </Text>
      ) : null}
    </Collapsible>
  );
}

function ProviderCheckButton({ check }: { check: ProviderConnectionCheck }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      label={check.checking ? "Checking…" : "Check"}
      icon={<RefreshCw aria-hidden="true" />}
      isDisabled={check.checking}
      onClick={check.run}
    />
  );
}

function ProviderCardHeader({
  provider,
  status,
  actions,
}: {
  provider: ProviderAuthStatusItem;
  status: ConnectionStatus;
  actions?: ReactNode;
}) {
  return (
    <HStack gap={3} vAlign="start">
      <ProviderIcon providerId={provider.id} label={provider.label} />
      <VStack gap={1} style={{ flex: 1, minInlineSize: 0 }}>
        <Heading level={3}>{provider.label}</Heading>
        <ProviderStatusLine status={status} />
      </VStack>
      {actions ? (
        <HStack gap={1} vAlign="center">
          {actions}
        </HStack>
      ) : null}
    </HStack>
  );
}

function ProviderApiKeyCard({
  provider,
  onSaved,
}: {
  provider: ProviderAuthStatusItem;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saveMutation = useMutation({
    mutationFn: () =>
      invoke<ProviderAuthStatusReport>("set_provider_api_key", {
        providerId: provider.id,
        apiKey,
      }),
    onSuccess: () => {
      bumpProviderConnectionEpoch(queryClient, provider.id);
      setApiKey("");
      setError(null);
      onSaved();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });
  const removeMutation = useMutation({
    mutationFn: () =>
      invoke<ProviderAuthStatusReport>("remove_provider_auth", {
        providerId: provider.id,
      }),
    onSuccess: () => {
      bumpProviderConnectionEpoch(queryClient, provider.id);
      setError(null);
      onSaved();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  const check = useProviderConnectionCheck(provider.id);
  const status = connectionStatus(provider, check);

  return (
    <Card data-testid={`provider-api-key-${provider.id}`}>
      <ProviderCardHeader
        provider={provider}
        status={status}
        actions={
          provider.configured ? (
            <>
              <ProviderCheckButton check={check} />
              <MoreMenu
                icon={<MoreHorizontal aria-hidden="true" />}
                label={`${provider.label} actions`}
                size="sm"
                variant="ghost"
                isDisabled={removeMutation.isPending}
                items={[
                  {
                    label: "Remove key…",
                    onClick: () => {
                      if (
                        window.confirm(
                          `Remove credentials for ${provider.label}? This cannot be undone from the UI.`,
                        )
                      ) {
                        removeMutation.mutate();
                      }
                    },
                  },
                ]}
              />
            </>
          ) : null
        }
      />
      <VStack gap={3} style={{ marginBlockStart: "var(--spacing-4)" }}>
        <ProviderStatusDetails detail={status.detail} />
        <TextInput
          label={`${provider.label} API key`}
          isLabelHidden
          placeholder="Paste API key"
          type="password"
          value={apiKey}
          onChange={(value) => setApiKey(value)}
        />
        <HStack gap={2} wrap="wrap" vAlign="center">
          <Button
            variant="primary"
            label={
              provider.configured && provider.mode === "api_key"
                ? "Replace key"
                : "Save key"
            }
            isDisabled={!apiKey.trim() || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          />
        </HStack>
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
      </VStack>
    </Card>
  );
}

function ProviderSubscriptionCard({
  provider,
  onSaved,
}: {
  provider: ProviderAuthStatusItem;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const loginMutation = useMutation({
    mutationFn: () =>
      invoke<ProviderAuthStatusReport>("login_provider_oauth", {
        providerId: provider.id,
      }),
    onSuccess: () => {
      bumpProviderConnectionEpoch(queryClient, provider.id);
      setError(null);
      onSaved();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });
  const logoutMutation = useMutation({
    mutationFn: () =>
      invoke<ProviderAuthStatusReport>("logout_provider_auth", {
        providerId: provider.id,
      }),
    onSuccess: () => {
      bumpProviderConnectionEpoch(queryClient, provider.id);
      setError(null);
      onSaved();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  const check = useProviderConnectionCheck(provider.id);
  const status = connectionStatus(provider, check);
  const signedIn = provider.mode === "oauth";
  const showLogin = !signedIn || status.needsSignIn;
  const loginLabel = loginMutation.isPending
    ? "Waiting for browser…"
    : signedIn
      ? "Sign in again"
      : "Login with subscription";

  return (
    <Card data-testid={`provider-subscription-${provider.id}`}>
      <ProviderCardHeader
        provider={provider}
        status={status}
        actions={
          <>
            {provider.configured ? <ProviderCheckButton check={check} /> : null}
            {signedIn ? (
              <MoreMenu
                icon={<MoreHorizontal aria-hidden="true" />}
                label={`${provider.label} actions`}
                size="sm"
                variant="ghost"
                isDisabled={logoutMutation.isPending}
                items={[
                  {
                    label: "Log out…",
                    onClick: () => {
                      if (window.confirm(`Log out of ${provider.label} subscription?`)) {
                        logoutMutation.mutate();
                      }
                    },
                  },
                ]}
              />
            ) : null}
          </>
        }
      />
      {showLogin || status.detail || error ? (
        <VStack gap={3} style={{ marginBlockStart: "var(--spacing-4)" }}>
          {showLogin ? (
            <HStack gap={2} wrap="wrap" vAlign="center">
              <Button
                variant="primary"
                label={loginLabel}
                isDisabled={loginMutation.isPending}
                onClick={() => loginMutation.mutate()}
              />
            </HStack>
          ) : null}
          <ProviderStatusDetails detail={status.detail} />
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
        </VStack>
      ) : null}
    </Card>
  );
}

function groupModelsByProvider(models: RuntimeModelCapability[]) {
  const groups = new Map<string, RuntimeModelCapability[]>();

  for (const model of models) {
    const group = groups.get(model.provider);

    if (group) {
      group.push(model);
    } else {
      groups.set(model.provider, [model]);
    }
  }

  return Array.from(groups, ([provider, providerModels]) => ({
    provider,
    models: providerModels,
  }));
}

/**
 * Which catalog models the composer selector may offer (issue #102). Stored
 * per install, read by the selector; nothing stored means "not configured"
 * and lists everything, while an empty set hides every model.
 */
function ModelVisibilitySection({
  models,
  isLoading,
  errorMessage,
  providerLabels,
  catalogOffline,
  refreshedAt,
  catalogErrors,
  refreshError,
  isRefreshing,
  onRefresh,
}: {
  models: RuntimeModelCapability[];
  isLoading: boolean;
  errorMessage?: string;
  providerLabels: Record<string, string>;
  catalogOffline: boolean;
  refreshedAt?: string;
  catalogErrors: Record<string, string>;
  refreshError?: string;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  const [visibleModels, setVisibleModels] = useState(getVisibleModels);

  // The checkboxes show what the selector will actually list, so they run
  // through the same predicate — including its "unconfigured means all" rule.
  // Persisting from this set also drops entries the catalog no longer has.
  const checkedModels = models.filter((model) =>
    isModelVisible(model, visibleModels),
  );

  const replaceProviderSelection = (provider: string, modelIds: string[]) => {
    const next = [
      ...checkedModels
        .filter((model) => model.provider !== provider)
        .map(({ provider: keptProvider, modelId }) => ({
          provider: keptProvider,
          modelId,
        })),
      ...modelIds.map((modelId) => ({ provider, modelId })),
    ];

    setVisibleModels(next);
    saveVisibleModels(next);
  };

  return (
    <VStack
      as="section"
      aria-labelledby="settings-models-heading"
      gap={3}
      id="models"
    >
      <VStack gap={2}>
        <Heading level={2} id="settings-models-heading">
          Models
        </Heading>
        <Text as="p" type="supporting">
          Choose which models the composer model selector offers.
        </Text>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Button
            variant="secondary"
            label="Refresh models"
            isDisabled={catalogOffline || isRefreshing}
            onClick={onRefresh}
          />
          {refreshedAt ? (
            <Text as="p" type="supporting">
              Last refreshed · <time dateTime={refreshedAt}>{formatTimestamp(refreshedAt)}</time>
            </Text>
          ) : null}
        </HStack>
        {catalogOffline ? (
          <Text as="p" type="supporting">
            Refresh is unavailable while PI_OFFLINE is set.
          </Text>
        ) : null}
        {refreshError ? (
          <Text
            as="p"
            type="supporting"
            role="alert"
            style={{ color: "var(--danger)" }}
          >
            {refreshError}
          </Text>
        ) : null}
        {Object.entries(catalogErrors).map(([providerId, message]) => (
          <Text
            as="p"
            key={providerId}
            type="supporting"
            role="alert"
            style={{ color: "var(--danger)" }}
          >
            {providerLabels[providerId] ?? providerId}: {message}
          </Text>
        ))}
      </VStack>

      {isLoading ? (
        <Text as="p" type="supporting">
          Loading…
        </Text>
      ) : null}
      {errorMessage ? (
        <Text
          as="p"
          type="supporting"
          role="alert"
          style={{ color: "var(--danger)" }}
        >
          {errorMessage}
        </Text>
      ) : null}
      {!isLoading && !errorMessage && models.length === 0 ? (
        <Text as="p" type="supporting">
          No models are available yet. Configure a provider in Providers first.
        </Text>
      ) : null}

      {groupModelsByProvider(models).map((group) => {
        const label = providerLabels[group.provider] ?? group.provider;
        const checkedIds = group.models
          .filter((model) => isModelVisible(model, visibleModels))
          .map((model) => model.modelId);

        return (
          <Card
            data-testid={`model-visibility-${group.provider}`}
            key={group.provider}
          >
            <HStack gap={3} vAlign="center">
              <ProviderIcon providerId={group.provider} label={label} />
              <Heading level={3}>{label}</Heading>
              <CheckboxInput
                label="Select all"
                size="sm"
                style={{ marginInlineStart: "auto" }}
                value={
                  checkedIds.length === group.models.length
                    ? true
                    : checkedIds.length === 0
                      ? false
                      : "indeterminate"
                }
                onChange={(checked) =>
                  replaceProviderSelection(
                    group.provider,
                    checked ? group.models.map((model) => model.modelId) : [],
                  )
                }
              />
            </HStack>
            <VStack style={{ marginBlockStart: "var(--spacing-4)" }}>
              <CheckboxList
                hasDividers
                isLabelHidden
                label={`${label} models`}
                width="100%"
              >
                {group.models.map((model) => (
                  <CheckboxListItem
                    description={model.modelId}
                    isChecked={checkedIds.includes(model.modelId)}
                    key={model.modelId}
                    label={model.name}
                    // The checkbox conveys visibility; a row fill implies navigation selection.
                    style={{ backgroundColor: "transparent" }}
                    onCheck={(checked) =>
                      replaceProviderSelection(
                        group.provider,
                        checked
                          ? [...checkedIds, model.modelId]
                          : checkedIds.filter((modelId) => modelId !== model.modelId),
                      )
                    }
                  />
                ))}
              </CheckboxList>
            </VStack>
          </Card>
        );
      })}
    </VStack>
  );
}

function updateStatusText(status: UpdateStatus) {
  switch (status.state) {
    case "disabled":
      return status.reason ?? "Updates are unavailable in this build.";
    case "idle":
      return "You're up to date.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return status.availableVersion
        ? `Version ${status.availableVersion} is available.`
        : "An update is available.";
    case "downloading":
      return typeof status.progressPercent === "number"
        ? `Downloading update… ${Math.round(status.progressPercent)}%`
        : "Downloading update…";
    case "ready":
      return status.availableVersion
        ? `Version ${status.availableVersion} is ready to install.`
        : "An update is ready to install.";
    case "error":
      return status.message ?? "Could not check for updates.";
  }
}

function AboutUpdatesSection() {
  const status = useUpdateStatus();
  const runtimeQuery = useQuery({
    queryKey: ["runtime-info"],
    queryFn: () => invoke<{ appVersion: string; piVersion: string; mode: "SDK" }>("get_runtime_info"),
  });
  const checkMutation = useMutation({
    mutationFn: () => invoke("update:check"),
  });
  const installMutation = useMutation({
    mutationFn: () => invoke("update:install"),
  });

  return (
    <VStack
      as="section"
      aria-labelledby="settings-about-heading"
      gap={3}
      data-testid="settings-about"
    >
      <VStack gap={2}>
        <Heading level={2} id="settings-about-heading">
          About & Updates
        </Heading>
        <HStack gap={3} vAlign="center">
          <img src={paceIcon} alt="" className="size-20 shrink-0" />
          <VStack gap={1}>
            <Heading level={3}>Pace Agent</Heading>
            <Text as="p" type="supporting">
              {status ? `Version ${status.currentVersion}` : "Loading version…"}
            </Text>
            {runtimeQuery.data?.piVersion ? (
              <Text as="p" type="supporting">
                Pi SDK {runtimeQuery.data.piVersion}
              </Text>
            ) : null}
          </VStack>
        </HStack>
        {status ? (
          <Text
            as="p"
            type="supporting"
            style={
              status.state === "error" ? { color: "var(--danger)" } : undefined
            }
          >
            {updateStatusText(status)}
          </Text>
        ) : null}
      </VStack>
      <Card>
        <HStack gap={2} wrap="wrap">
          <Button
            variant="primary"
            label="Check for updates"
            isDisabled={
              !status ||
              status.state === "disabled" ||
              status.state === "checking" ||
              checkMutation.isPending
            }
            onClick={() => checkMutation.mutate()}
          />
          {status?.state === "ready" ? (
            <Button
              variant="primary"
              label="Restart to update"
              isDisabled={installMutation.isPending}
              onClick={() => installMutation.mutate()}
            />
          ) : null}
        </HStack>
      </Card>
    </VStack>
  );
}

function ChatsSettingsSection({ enabled }: { enabled: boolean }) {
  const rootQuery = useQuery({
    queryKey: ["chat-workspace-root"],
    queryFn: () => invoke<{ path: string }>("get_chat_workspace_root"),
    enabled,
  });
  const path = rootQuery.data?.path ?? "";

  return (
    <VStack
      as="section"
      aria-labelledby="settings-chats-heading"
      gap={3}
      data-testid="settings-chats"
    >
      <VStack gap={2}>
        <Heading level={2} id="settings-chats-heading">
          Chats
        </Heading>
        <Text as="p" type="supporting">
          Each Chat Session works in its own folder under this directory.
        </Text>
      </VStack>
      <Card>
        <VStack gap={3}>
          <Text as="p" type="supporting">
            {rootQuery.isPending ? "Loading…" : path || "Chat workspace path unavailable."}
          </Text>
          <Button
            variant="secondary"
            label="Open folder"
            isDisabled={!path}
            onClick={() => {
              void revealProjectInFinder(path, { ensure: true });
            }}
          />
        </VStack>
      </Card>
    </VStack>
  );
}

function SettingsContent({
  section,
  onSectionChange,
  onClose,
  compact,
}: {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
  compact: boolean;
}) {
  const queryClient = useQueryClient();
  const updateStatus = useUpdateStatus();
  const updateIndicator =
    updateStatus?.state === "ready" ? (
      <Token
        size="sm"
        color="green"
        label="Ready"
        description="Update ready to install"
      />
    ) : updateStatus?.state === "available" || updateStatus?.state === "downloading" ? (
      <Token
        size="sm"
        color="blue"
        label="Update"
        description="Update available"
      />
    ) : undefined;
  const [tab, setTab] = useState<AuthTab>("subscription");
  const [apiKeyFilter, setApiKeyFilter] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);
  const statusQuery = useQuery({
    queryKey: providerAuthStatusQueryKey,
    queryFn: listProviderAuthStatus,
  });

  const providers = statusQuery.data?.providers ?? [];
  const subscriptionProviders = useMemo(
    () => providers.filter((provider) => provider.supportsOAuth),
    [providers],
  );
  const visibleApiKeyProviders = useMemo(() => {
    const query = apiKeyFilter.trim().toLowerCase();
    return providers.filter((provider) => {
      if (!provider.supportsApiKey) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        provider.label.toLowerCase().includes(query) ||
        provider.id.toLowerCase().includes(query)
      );
    });
  }, [apiKeyFilter, providers]);

  const providerLabels = useMemo(
    () =>
      Object.fromEntries(
        providers.map((provider) => [provider.id, provider.label]),
      ),
    [providers],
  );
  const modelsQuery = useQuery({
    queryKey: availableModelControlsQueryKey,
    queryFn: () =>
      invoke<RuntimeModelControls>("list_available_model_controls"),
  });
  const [catalogResult, setCatalogResult] = useState<ModelCatalogRefreshResult>();
  const [catalogRefreshError, setCatalogRefreshError] = useState<string>();
  const catalogRefreshBusy = useSyncExternalStore(
    subscribeCatalogRefreshBusy,
    isCatalogRefreshBusy,
    isCatalogRefreshBusy,
  );
  const runCatalogRefresh = useCallback(
    (force: boolean) => {
      const promise = startCatalogRefresh(force, () =>
        invoke<ModelCatalogRefreshResult>("refresh_model_catalog", { force }),
      );
      void promise.then(
        (result) => {
          setCatalogRefreshError(undefined);
          setCatalogResult(result);
          if ("offline" in result) return;
          // Draft composers keep this catalog in module state. Drop it so the
          // next new Session paints the models the network refresh just stored.
          invalidateCachedModelCatalog();
          void queryClient.invalidateQueries({
            queryKey: availableModelControlsQueryKey,
          });
        },
        (error: unknown) => {
          setCatalogRefreshError(
            error instanceof Error ? error.message : "Could not refresh models.",
          );
        },
      );
    },
    [queryClient],
  );
  useEffect(() => {
    if (section !== "models") return;
    runCatalogRefresh(false);
  }, [section, runCatalogRefresh]);
  const catalogOffline = catalogResult !== undefined && "offline" in catalogResult;
  const modelCatalogError = !modelsQuery.isError
    ? undefined
    : modelsQuery.error instanceof Error
      ? modelsQuery.error.message
      : "Could not load the model catalog.";

  const refresh = () => {
    // Draft composers keep this catalog in module state. Drop it before the
    // queries refetch, or the next new Session still paints the old models.
    invalidateCachedModelCatalog();
    void queryClient.invalidateQueries({
      queryKey: providerAuthStatusQueryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: ["environment-preflight-report"],
    });
    // New credentials change which models Pi offers, so refresh the catalog too.
    void queryClient.invalidateQueries({
      queryKey: availableModelControlsQueryKey,
    });
  };

  return (
    <Layout
      padding={4}
      style={{
        height: compact ? "100dvh" : "min(85dvh, calc(var(--spacing-10) * 17))",
      }}
      header={
        <VStack gap={0}>
          <DialogHeader title="Settings" onOpenChange={onClose} hasDivider />
          {compact ? (
            <TabList
              aria-label="Settings sections"
              value={section}
              onChange={(value) => onSectionChange(value as SettingsSection)}
              layout="fill"
              hasDivider
            >
              {settingsSections.map((item) => (
                <Tab
                  key={item.id}
                  value={item.id}
                  label={item.id === "about" ? "About" : item.label}
                  endContent={item.id === "about" ? updateIndicator : undefined}
                  style={{
                    paddingInline: "var(--spacing-2)",
                    height: updateIndicator
                      ? "calc(var(--spacing-8) * 2)"
                      : undefined,
                    flexDirection: "column",
                    gap: "var(--spacing-1)",
                  }}
                />
              ))}
            </TabList>
          ) : null}
        </VStack>
      }
      start={
        compact ? undefined : (
          <LayoutPanel
            padding={2}
            width="calc(var(--spacing-10) * 7)"
            hasDivider
          >
            <SideNav aria-label="Settings sections" style={{ width: "100%" }}>
              <VStack gap={1}>
                {settingsSections.map(({ id, label, icon: Icon }) => (
                  <SideNavItem
                    key={id}
                    label={label}
                    endContent={id === "about" ? updateIndicator : undefined}
                    icon={
                      <Icon
                        aria-hidden="true"
                        style={{
                          width: "var(--spacing-4)",
                          height: "var(--spacing-4)",
                        }}
                      />
                    }
                    isSelected={section === id}
                    onClick={() => onSectionChange(id)}
                  />
                ))}
              </VStack>
            </SideNav>
          </LayoutPanel>
        )
      }
    >
      <LayoutContent ref={contentRef} padding={compact ? 4 : 6}>
        <VStack gap={6}>
          <VStack
            style={{ display: section === "providers" ? undefined : "none" }}
          >
            <VStack
              as="section"
              aria-labelledby="settings-providers-heading"
              gap={3}
            >
              <VStack gap={2}>
                <Heading level={2} id="settings-providers-heading">
                  Providers
                </Heading>
                <Text as="p" type="supporting">
                  Configure model credentials. Keys are stored in Pi{" "}
                  <code>auth.json</code> and never shown in full after save.
                </Text>
                {statusQuery.data ? (
                  <Text as="p" type="supporting">
                    {statusQuery.data.configuredCount} provider
                    {statusQuery.data.configuredCount === 1 ? "" : "s"}{" "}
                    configured
                  </Text>
                ) : null}
              </VStack>

              <VStack>
                <TabList
                  hasDivider
                  value={tab}
                  onChange={(value) => {
                    if (value === "subscription" || value === "api_key") {
                      setTab(value);
                    }
                  }}
                >
                  <Tab value="subscription" label="Subscription" />
                  <Tab value="api_key" label="API Key" />
                </TabList>
                {tab === "subscription" ? (
                  <VStack
                    gap={3}
                    style={{ marginBlockStart: "var(--spacing-4)" }}
                  >
                    <Text as="p" type="supporting">
                      Log in with a provider subscription via Pi OAuth
                      (browser). Uses the same Pi <code>auth.json</code> as the
                      local TUI.
                    </Text>
                    {statusQuery.isLoading ? (
                      <Text as="p" type="supporting">
                        Loading…
                      </Text>
                    ) : (
                      subscriptionProviders.map((provider) => (
                        <ProviderSubscriptionCard
                          key={provider.id}
                          provider={provider}
                          onSaved={refresh}
                        />
                      ))
                    )}
                  </VStack>
                ) : (
                  <VStack
                    gap={3}
                    style={{ marginBlockStart: "var(--spacing-4)" }}
                  >
                    <Text as="p" type="supporting">
                      Paste an API key for a provider that accepts one.
                    </Text>
                    <TextInput
                      label="Filter providers"
                      isLabelHidden
                      placeholder="Filter providers"
                      value={apiKeyFilter}
                      onChange={setApiKeyFilter}
                      width="100%"
                    />
                    {statusQuery.isLoading ? (
                      <Text as="p" type="supporting">
                        Loading…
                      </Text>
                    ) : (
                      visibleApiKeyProviders.map((provider) => (
                        <ProviderApiKeyCard
                          key={provider.id}
                          provider={provider}
                          onSaved={refresh}
                        />
                      ))
                    )}
                  </VStack>
                )}
              </VStack>

              {statusQuery.isError ? (
                <Text
                  as="p"
                  type="supporting"
                  role="alert"
                  style={{ color: "var(--danger)" }}
                >
                  {statusQuery.error instanceof Error
                    ? statusQuery.error.message
                    : "Could not load provider status."}
                </Text>
              ) : null}
            </VStack>
          </VStack>
          <VStack
            style={{ display: section === "models" ? undefined : "none" }}
          >
            <ModelVisibilitySection
              catalogErrors={
                catalogResult && "errors" in catalogResult ? catalogResult.errors : {}
              }
              catalogOffline={catalogOffline}
              errorMessage={modelCatalogError}
              isLoading={modelsQuery.isPending}
              isRefreshing={catalogRefreshBusy}
              models={modelsQuery.data?.models ?? []}
              onRefresh={() => runCatalogRefresh(true)}
              providerLabels={providerLabels}
              refreshError={catalogRefreshError}
              refreshedAt={
                catalogResult && "refreshedAt" in catalogResult
                  ? catalogResult.refreshedAt
                  : undefined
              }
            />
          </VStack>
          <VStack
            style={{ display: section === "chats" ? undefined : "none" }}
          >
            <ChatsSettingsSection enabled={section === "chats"} />
          </VStack>
          <VStack style={{ display: section === "changelog" ? undefined : "none" }}>
            <ChangelogSection />
          </VStack>
          <VStack style={{ display: section === "about" ? undefined : "none" }}>
            <AboutUpdatesSection />
          </VStack>
        </VStack>
      </LayoutContent>
    </Layout>
  );
}

const settingsSections = [
  { id: "providers", label: "Providers", icon: AnimatedKey },
  { id: "models", label: "Models", icon: AnimatedRobot },
  { id: "chats", label: "Chats", icon: AnimatedMessage },
  { id: "changelog", label: "Changelog", icon: AnimatedFile },
  { id: "about", label: "About & Updates", icon: AnimatedInformationCircle },
] as const;

export function SettingsDialog() {
  const { section, openSettings, closeSettings } = useSettingsDialog();
  const compact = useMediaQuery("(max-width: 640px)");
  const isOpen = section !== null;
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // DialogHeader focuses its title in a passive effect before Dialog records
  // the opener. Capture it during layout, then restore after Dialog closes.
  useLayoutEffect(() => {
    if (isOpen)
      returnFocusRef.current = document.activeElement as HTMLElement | null;
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
      returnFocusRef.current = null;
    }
  }, [isOpen]);

  return (
    <Dialog
      aria-label="Settings"
      data-testid="settings-dialog"
      isOpen={isOpen}
      onOpenChange={(isOpen) => {
        if (!isOpen) closeSettings();
      }}
      purpose="form"
      width="calc(var(--spacing-10) * 22)"
      maxHeight="90dvh"
      variant={compact ? "fullscreen" : "standard"}
      padding={4}
    >
      {section ? (
        <SettingsContent
          section={section}
          onSectionChange={openSettings}
          onClose={closeSettings}
          compact={compact}
        />
      ) : null}
    </Dialog>
  );
}

export type { ProviderAuthId };
