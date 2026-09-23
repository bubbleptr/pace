import type { PiRuntimeDriver, RuntimeGatewayDriverEvent } from "../gateway/runtime-gateway";

export type SessionProcessMethod = Exclude<keyof PiRuntimeDriver, "onEvent">;
export type SessionProcessArgs<M extends SessionProcessMethod> = Parameters<NonNullable<PiRuntimeDriver[M]>>;
export type SessionProcessResult<M extends SessionProcessMethod> = Awaited<ReturnType<NonNullable<PiRuntimeDriver[M]>>>;
export type SessionProcessRequest = {
  [M in SessionProcessMethod]: { type: "request"; id: number; method: M; args: SessionProcessArgs<M> }
}[SessionProcessMethod];
export type SessionProcessResponse = { type: "response"; id: number; result?: unknown; error?: string };
export type SessionProcessEvent = { type: "event"; event: RuntimeGatewayDriverEvent };

/**
 * Every message on the Session process channel, in both directions, told
 * apart by `type`. Other protocols sharing the channel (e.g. chord messages)
 * join this union as new kinds; both ends ignore kinds they do not handle.
 */
export type SessionProcessMessage = SessionProcessRequest | SessionProcessResponse | SessionProcessEvent;
