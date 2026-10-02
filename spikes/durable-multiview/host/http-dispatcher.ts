// Copied from pi's packages/coding-agent/src/core/http-dispatcher.ts (MIT, Earendil Works)
// at the 1.0.0 release, trimmed to what the host calls. It is outside pi-coding-agent's
// package exports, and the upstream durable harness notes that without it some provider
// streams break off.
import { EventEmitter } from "node:events";
import * as undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

export function applyHttpProxySettings(httpProxy: string | undefined): void {
  const proxy = httpProxy?.trim();
  if (!proxy) return;
  process.env.HTTP_PROXY ??= proxy;
  process.env.HTTPS_PROXY ??= proxy;
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing the host.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }
  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createUndiciClient,
    }),
  );
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }
  const normalizedTimeoutMs = Math.floor(timeoutMs);
  const dispatcher = withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      // Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
      proxyTunnel: true,
      bodyTimeout: normalizedTimeoutMs,
      connect: {
        autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
      },
      headersTimeout: normalizedTimeoutMs,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
  undici.setGlobalDispatcher(dispatcher);
  // Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
  // bundled fetch can otherwise consume compressed responses through npm undici's
  // dispatcher without decompressing them, causing response.json() failures.
  // If a caller replaced fetch after module load, preserve that deliberate override.
  const shouldInstallGlobals =
    installedGlobalFetch === undefined ? globalThis.fetch === originalGlobalFetch : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install?.();
    installedGlobalFetch = globalThis.fetch;
  }
}
