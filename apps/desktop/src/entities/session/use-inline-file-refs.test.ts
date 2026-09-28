import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useInlineFileRefs } from "@/entities/session/use-inline-file-refs";

const scope = { sessionId: "s1", cwd: "/root", diffRoot: "/root" };

describe("useInlineFileRefs", () => {
  it("resolves every candidate in one request with diff-root-relative paths", async () => {
    const resolve = vi.fn(async () => ({ files: ["src/a.ts", "src/b.ts"] }));
    const { result } = renderHook(() =>
      useInlineFileRefs(scope, "See `src/a.ts` and `src/b.ts`.", resolve),
    );

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("s1", ["src/a.ts", "src/b.ts"]);
    expect(result.current.has("src/a.ts")).toBe(true);
    expect(result.current.has("src/b.ts")).toBe(true);
  });

  it("maps a line-suffixed span to the same confirmed file", async () => {
    const resolve = vi.fn(async () => ({ files: ["src/a.ts"] }));
    const { result } = renderHook(() =>
      useInlineFileRefs(scope, "See `src/a.ts` and `src/a.ts:3`.", resolve),
    );

    await waitFor(() => expect(result.current.size).toBe(2));
    // Both spellings resolved to one path, so the request lists it once.
    expect(resolve).toHaveBeenCalledWith("s1", ["src/a.ts"]);
    expect(result.current.has("src/a.ts")).toBe(true);
    expect(result.current.has("src/a.ts:3")).toBe(true);
  });

  it("only reports candidates the backend confirmed", async () => {
    const resolve = vi.fn(async () => ({ files: ["src/a.ts"] }));
    const { result } = renderHook(() =>
      useInlineFileRefs(scope, "See `src/a.ts` and `src/missing.ts`.", resolve),
    );

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.has("src/a.ts")).toBe(true);
    expect(result.current.has("src/missing.ts")).toBe(false);
  });

  it("makes no request for a candidate that resolves outside the root", async () => {
    const resolve = vi.fn(async () => ({ files: [] }));
    const { result } = renderHook(() =>
      useInlineFileRefs(scope, "See `../outside.ts` and `/abs/path.ts`.", resolve),
    );

    await act(async () => {});
    expect(resolve).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });

  it("makes no request without a scope", async () => {
    const resolve = vi.fn(async () => ({ files: [] }));
    const { result } = renderHook(() =>
      useInlineFileRefs(null, "See `src/a.ts`.", resolve),
    );

    await act(async () => {});
    expect(resolve).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });

  it("ignores a response that resolves after the markdown changed", async () => {
    const gates: Array<(value: { files: string[] }) => void> = [];
    const resolve = vi.fn(
      () => new Promise<{ files: string[] }>((resolve) => gates.push(resolve)),
    );
    const { result, rerender } = renderHook(
      ({ markdown }) => useInlineFileRefs(scope, markdown, resolve),
      { initialProps: { markdown: "See `src/a.ts`." } },
    );

    rerender({ markdown: "See `src/b.ts`." });
    await act(async () => {
      gates[0]!({ files: ["src/a.ts"] });
    });
    expect(result.current.size).toBe(0);

    await act(async () => {
      gates[1]!({ files: ["src/b.ts"] });
    });
    expect(result.current.has("src/b.ts")).toBe(true);
    expect(result.current.has("src/a.ts")).toBe(false);
  });

  it("returns an empty set when the request fails", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("rpc unavailable");
    });
    const { result } = renderHook(() =>
      useInlineFileRefs(scope, "See `src/a.ts`.", resolve),
    );

    await act(async () => {});
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });

  it("splits more than 100 distinct paths across chunked requests", async () => {
    const names = Array.from({ length: 101 }, (_, i) => `dir/file${i}.ts`);
    const calls: string[][] = [];
    const resolve = vi.fn(async (_sessionId: string, paths: string[]) => {
      calls.push(paths);
      return { files: paths };
    });
    const { result } = renderHook(() =>
      useInlineFileRefs(scope, names.map((name) => `\`${name}\``).join(" "), resolve),
    );

    await waitFor(() => expect(result.current.size).toBe(101));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(100);
    expect(calls[1]).toEqual(["dir/file100.ts"]);
  });

  it("returns an empty set when any chunk of a batched request fails", async () => {
    const names = Array.from({ length: 101 }, (_, i) => `dir/file${i}.ts`);
    let call = 0;
    const resolve = vi.fn(async (_sessionId: string, paths: string[]) => {
      call += 1;
      if (call === 2) throw new Error("rpc unavailable");
      return { files: paths };
    });
    const { result } = renderHook(() =>
      useInlineFileRefs(scope, names.map((name) => `\`${name}\``).join(" "), resolve),
    );

    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(result.current.size).toBe(0);
  });

  it("does not serve a stale confirmation when the same markdown is re-requested", async () => {
    const gates: Array<{
      res: (value: { files: string[] }) => void;
      rej: (error: Error) => void;
    }> = [];
    const resolve = vi.fn(
      () =>
        new Promise<{ files: string[] }>((res, rej) => {
          gates.push({ res, rej });
        }),
    );
    const { result, rerender } = renderHook(
      ({ markdown }) => useInlineFileRefs(scope, markdown, resolve),
      { initialProps: { markdown: "See `a.ts`." } },
    );

    await act(async () => {
      gates[0]!.res({ files: ["a.ts"] });
    });
    expect(result.current.has("a.ts")).toBe(true);

    // Leave B's request in flight; back on A, the old A result must not be
    // served while the new request is pending.
    rerender({ markdown: "See `b.ts`." });
    rerender({ markdown: "See `a.ts`." });
    expect(result.current.has("a.ts")).toBe(false);

    await act(async () => {
      gates[2]!.rej(new Error("rpc unavailable"));
    });
    expect(result.current.has("a.ts")).toBe(false);
  });
});
