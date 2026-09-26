import { it, expect, vi } from "vitest";
import { callWithLog, type LlmCallLogEntry } from "./logging";

const base = { workspaceId: "ws", agent: "creative-writer", promptVersion: "creative-v1", model: "m" };

it("writes a COMPLETED row with real token usage and duration, never content", async () => {
  const rows: LlmCallLogEntry[] = [];
  const sink = vi.fn(async (entry: LlmCallLogEntry) => {
    rows.push(entry);
  });
  const result = await callWithLog({
    ...base,
    sink,
    run: async () => ({ text: "GİZLİ İÇERİK", usage: { inputTokens: 12, outputTokens: 34 } }),
  });
  expect(result.text).toBe("GİZLİ İÇERİK");
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ...base, status: "COMPLETED", inputTokens: 12, outputTokens: 34 });
  expect(JSON.stringify(rows)).not.toContain("GİZLİ");
});

it("writes a FAILED row (zero tokens) and rethrows on error", async () => {
  const sink = vi.fn(async () => {});
  await expect(
    callWithLog({
      ...base,
      sink,
      run: async () => {
        throw new Error("upstream");
      },
    }),
  ).rejects.toThrow("upstream");
  expect(sink).toHaveBeenCalledWith(
    expect.objectContaining({ status: "FAILED", inputTokens: 0, outputTokens: 0 }),
  );
});

it("does not fail the call when the log sink itself fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const result = await callWithLog({
    ...base,
    sink: async () => {
      throw new Error("db down");
    },
    run: async () => ({ usage: { inputTokens: 1, outputTokens: 1 }, ok: true }),
  });
  expect(result.ok).toBe(true);
  expect(warn).toHaveBeenCalled();
  expect(String(warn.mock.calls[0]?.[0])).not.toContain("db down");
  warn.mockRestore();
});
