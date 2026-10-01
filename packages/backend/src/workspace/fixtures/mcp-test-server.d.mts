// Types for the dependency-free MCP test server fixture. The handler is the
// counterpart under test, so the HTTP variant imports it rather than copying
// the logic.

export declare function handleMcpMessage(message: {
  id?: string | number | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
}): unknown;
