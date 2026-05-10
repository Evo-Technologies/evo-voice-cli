import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumePending,
  getPending,
  loadConfig,
  pendingPath,
  recordPending,
  saveConfig,
  type PendingAction,
} from "../src/config.js";
import { EXIT } from "../src/exit-codes.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evov-test-"));
  process.env.EVO_VOICE_CONFIG_DIR = path.join(tmpRoot, "config");
  process.env.EVO_VOICE_CACHE_DIR = path.join(tmpRoot, "cache");
});

afterEach(() => {
  delete process.env.EVO_VOICE_CONFIG_DIR;
  delete process.env.EVO_VOICE_CACHE_DIR;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

function newAction(overrides: Partial<PendingAction> = {}): PendingAction {
  const now = new Date();
  return {
    token: "tok123",
    env: "prod",
    baseUrl: "https://evovoice.io",
    accountId: "acc1",
    accountName: "Acme Corp",
    method: "DELETE",
    path: "/sessions",
    query: { accountId: "acc1", startDateTime: "2026-05-04T00:00:00Z", endDateTime: "2026-05-10T23:59:59Z" },
    action: "DELETE /sessions",
    summary: "Delete sessions for Acme Corp on PRODUCTION between 2026-05-04 and 2026-05-10",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

describe("pending actions store", () => {
  it("records and retrieves a pending action by token", () => {
    const a = newAction();
    recordPending(a);
    const fetched = getPending(a.token);
    expect(fetched.summary).toBe(a.summary);
    expect(fetched.method).toBe("DELETE");
  });

  it("stores to mode-600 file (skipped on Windows)", () => {
    recordPending(newAction());
    expect(fs.existsSync(pendingPath())).toBe(true);
    if (process.platform !== "win32") {
      const mode = fs.statSync(pendingPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("rejects an unknown token with EXIT.AUTH", () => {
    expect(() => getPending("nope")).toThrowError(
      expect.objectContaining({ code: EXIT.AUTH, message: expect.stringContaining("Unknown token") }),
    );
  });

  it("rejects an expired token with EXIT.AUTH", () => {
    const a = newAction({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    recordPending(a);
    expect(() => getPending(a.token)).toThrowError(
      expect.objectContaining({ code: EXIT.AUTH, message: expect.stringContaining("expired") }),
    );
  });

  it("rejects a consumed token (single-use)", () => {
    const a = newAction();
    recordPending(a);
    consumePending(a.token);
    expect(() => getPending(a.token)).toThrowError(
      expect.objectContaining({ code: EXIT.AUTH, message: expect.stringContaining("already consumed") }),
    );
  });

  it("preserves the action's original env+baseUrl on retrieval (cannot redirect by switching envs)", () => {
    const a = newAction({ env: "prod", baseUrl: "https://evovoice.io" });
    recordPending(a);

    // Simulate user switching active env between phase 1 and phase 2
    const cfg = loadConfig();
    cfg.activeEnv = "staging";
    saveConfig(cfg);

    const fetched = getPending(a.token);
    expect(fetched.env).toBe("prod");
    expect(fetched.baseUrl).toBe("https://evovoice.io");
  });
});
