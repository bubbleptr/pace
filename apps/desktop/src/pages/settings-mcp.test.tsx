import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSettingsSection } from "@/pages/settings-mcp";
import type { PaceRendererApi } from "@/shared/runtime";
import type {
  McpActionResult,
  McpConfigReport,
  McpProbeReport,
} from "@pace/core";

const mcpConfig: McpConfigReport = {
  configPath: "/agent/mcp.json",
  errors: [],
  servers: [
    {
      name: "filesystem",
      source: "/agent/mcp.json",
      enabled: true,
      exposure: "codemode",
      kind: "stdio",
      transport: "npx -y @modelcontextprotocol/server-filesystem .",
      usesOAuth: false,
    },
    {
      name: "sentry",
      source: "/agent/mcp.json",
      enabled: true,
      exposure: "codemode",
      kind: "http",
      transport: "https://mcp.sentry.dev/mcp",
      usesOAuth: true,
    },
    {
      name: "legacy-db",
      source: "/agent/mcp.json",
      enabled: true,
      exposure: "direct",
      kind: "stdio",
      transport: "node db-server.js",
      usesOAuth: false,
    },
    {
      name: "playwright",
      source: "/agent/mcp.json",
      enabled: false,
      exposure: "codemode",
      kind: "stdio",
      transport: "npx -y @playwright/mcp",
      usesOAuth: false,
    },
  ],
};

const mcpProbe: McpProbeReport = {
  errors: [],
  servers: [
    {
      name: "filesystem",
      state: "connected",
      tools: ["read_file", "write_file", "list_directory"],
    },
    { name: "sentry", state: "needs-auth", tools: [] },
    {
      name: "legacy-db",
      state: "failed",
      tools: [],
      error: 'MCP server "legacy-db" failed to connect: spawn node ENOENT',
    },
    { name: "playwright", state: "disabled", tools: [] },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type McpRenderOptions = {
  config?: McpConfigReport;
  probe?: McpProbeReport;
  /** When set, probe_mcp_servers returns this promise instead of resolving. */
  probePromise?: Promise<McpProbeReport>;
  handlers?: Record<string, (args?: Record<string, unknown>) => unknown>;
};

function renderMcpSection(options: McpRenderOptions = {}) {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "get_mcp_config") {
      return options.config ?? mcpConfig;
    }

    const handler = options.handlers?.[command];
    if (handler) {
      return handler(args);
    }

    if (command === "probe_mcp_servers") {
      return options.probePromise ?? options.probe ?? mcpProbe;
    }

    throw new Error(`unexpected backend command ${command}`);
  });

  window.pace = {
    invoke: invoke as unknown as PaceRendererApi["invoke"],
    onBackendEvent: vi.fn(() => vi.fn()),
    onBrowserEvent: vi.fn(() => vi.fn()),
    onUpdateEvent: vi.fn(() => vi.fn()),
    onWindowFocusChanged: vi.fn(() => vi.fn()),
    onNavigateRequest: vi.fn(() => vi.fn()),
  };

  const queryClient = new QueryClient();
  const tree = render(
    <QueryClientProvider client={queryClient}>
      <McpSettingsSection enabled />
    </QueryClientProvider>,
  );

  return {
    ...tree,
    invoke,
    countCalls: (command: string) =>
      invoke.mock.calls.filter(([called]) => called === command).length,
  };
}

async function findMcpSection() {
  return screen.findByRole("region", { name: "MCP" });
}

afterEach(() => {
  delete window.pace;
});

describe("Settings — MCP servers", () => {
  it("renders configured rows while the probe is pending, then shows probed states", async () => {
    const probe = deferred<McpProbeReport>();
    renderMcpSection({ probePromise: probe.promise });

    const section = await findMcpSection();
    await within(section).findByText("filesystem");
    for (const name of ["sentry", "legacy-db", "playwright"]) {
      expect(within(section).getByText(name)).toBeInTheDocument();
    }
    // Enabled rows probe until the result lands; a disabled row knows its state.
    expect(within(section).getAllByText("Checking…")).toHaveLength(3);
    expect(within(section).getByText("Disabled")).toBeInTheDocument();

    await act(async () => {
      probe.resolve(mcpProbe);
    });

    const sentry = await screen.findByTestId("mcp-server-sentry");
    expect(within(sentry).getByText("Needs sign-in")).toBeInTheDocument();
    expect(
      within(sentry).getByRole("button", { name: "Sign in" }),
    ).toBeInTheDocument();

    const filesystem = screen.getByTestId("mcp-server-filesystem");
    expect(within(filesystem).getByText(/3 tools/)).toBeInTheDocument();

    const legacyDb = screen.getByTestId("mcp-server-legacy-db");
    expect(within(legacyDb).getByText(/ENOENT/)).toBeInTheDocument();
  });

  it("toggles a server through set_mcp_server_enabled and re-probes", async () => {
    const user = userEvent.setup();
    const { invoke, countCalls } = renderMcpSection({
      handlers: {
        set_mcp_server_enabled: (args) => ({
          ...mcpConfig,
          servers: mcpConfig.servers.map((server) =>
            server.name === args?.name
              ? { ...server, enabled: args.enabled === true }
              : server,
          ),
        }),
      },
    });

    const section = await findMcpSection();
    expect(await within(section).findByText(/3 tools/)).toBeInTheDocument();
    expect(countCalls("probe_mcp_servers")).toBe(1);

    const filesystem = screen.getByTestId("mcp-server-filesystem");
    await user.click(
      within(filesystem).getByRole("switch", { name: "Enable filesystem" }),
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("set_mcp_server_enabled", {
        name: "filesystem",
        enabled: false,
      });
    });
    await waitFor(() => {
      expect(countCalls("probe_mcp_servers")).toBe(2);
    });
  });

  it("shows Checking… while a re-probe is in flight instead of the stale state", async () => {
    const user = userEvent.setup();
    const reprobe = deferred<McpProbeReport>();
    let probeCalls = 0;
    renderMcpSection({
      handlers: {
        probe_mcp_servers: () => {
          probeCalls += 1;
          return probeCalls === 1 ? mcpProbe : reprobe.promise;
        },
        set_mcp_server_enabled: (args) => ({
          ...mcpConfig,
          servers: mcpConfig.servers.map((server) =>
            server.name === args?.name
              ? { ...server, enabled: args.enabled === true }
              : server,
          ),
        }),
      },
    });

    const playwright = await screen.findByTestId("mcp-server-playwright");
    expect(await within(playwright).findByText("Disabled")).toBeInTheDocument();

    await user.click(
      within(playwright).getByRole("switch", { name: "Enable playwright" }),
    );

    // The toggle wrote enabled:true and invalidated the probe; while the fresh
    // probe is in flight the row must not keep showing the stale "Disabled".
    expect(await within(playwright).findByText("Checking…")).toBeInTheDocument();
    expect(within(playwright).queryByText("Disabled")).not.toBeInTheDocument();

    await act(async () => {
      reprobe.resolve({
        errors: [],
        servers: [
          ...mcpProbe.servers.filter((server) => server.name !== "playwright"),
          {
            name: "playwright",
            state: "connected",
            tools: ["browser_navigate"],
          },
        ],
      });
    });

    expect(await within(playwright).findByText("Connected")).toBeInTheDocument();
  });

  it("shows the pending state during sign-in and reports a failed result", async () => {
    const user = userEvent.setup();
    const login = deferred<McpActionResult>();
    renderMcpSection({
      handlers: { login_mcp_server: () => login.promise },
    });

    const sentry = await screen.findByTestId("mcp-server-sentry");
    await user.click(within(sentry).getByRole("button", { name: "Sign in" }));

    expect(
      await within(sentry).findByRole("button", { name: "Waiting for browser…" }),
    ).toBeDisabled();

    await act(async () => {
      login.resolve({ ok: false, message: "Sign-in timed out." });
    });

    expect(await within(sentry).findByRole("alert")).toHaveTextContent(
      "Sign-in timed out.",
    );
  });

  it("keeps the add dialog open on a failed result and splits arguments by line", async () => {
    const user = userEvent.setup();
    const add = vi.fn(async () => ({
      ok: false,
      message: 'An MCP server named "github" already exists.',
    }));
    const { invoke } = renderMcpSection({
      handlers: { add_mcp_server: add },
    });

    const section = await findMcpSection();
    await user.click(within(section).getByRole("button", { name: "Add server" }));

    const dialog = await screen.findByRole("dialog", { name: "Add server" });
    const submit = within(dialog).getByRole("button", { name: "Add server" });
    expect(submit).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Name"), "github");
    await user.type(within(dialog).getByLabelText("Command"), "npx");
    await user.type(
      within(dialog).getByLabelText("Arguments"),
      "-y\n@modelcontextprotocol/server-github\n\n--flag value",
    );
    expect(submit).toBeEnabled();

    await user.click(submit);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("add_mcp_server", {
        input: {
          kind: "stdio",
          name: "github",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github", "--flag value"],
        },
      });
    });
    expect(
      await within(dialog).findByRole("alert"),
    ).toHaveTextContent('already exists');
    expect(
      screen.getByRole("dialog", { name: "Add server" }),
    ).toBeInTheDocument();
  });

  it("removes a server only after confirmation", async () => {
    const user = userEvent.setup();
    const remove = vi.fn(async () => ({ ok: true, message: "" }));
    const { invoke } = renderMcpSection({
      handlers: { remove_mcp_server: remove },
    });

    const filesystem = await screen.findByTestId("mcp-server-filesystem");
    await user.click(
      within(filesystem).getByRole("button", { name: "filesystem actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /Remove/ }));

    const dialog = await screen.findByRole("dialog", {
      name: "Remove MCP server",
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "remove_mcp_server",
      expect.anything(),
    );

    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("remove_mcp_server", {
        name: "filesystem",
      });
    });
  });
});
