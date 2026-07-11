import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../src/cli.js";
import {
  ENV_DEFAULTS,
  getPending,
  loadConfig,
  recordPending,
  saveConfig,
  type ConfigFile,
  type PendingAction,
} from "../src/config.js";
import { EXIT } from "../src/exit-codes.js";
import {
  configureTenantGuard,
  confirmTenantContext,
  tenantGuardStatus,
} from "../src/tenant-guard.js";

let tmpRoot: string;
let stdoutSpy: any;
let stderrSpy: any;
const fetchMock = vi.fn();

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evov-tenant-guard-"));
  process.env.EVO_VOICE_CONFIG_DIR = path.join(tmpRoot, "config");
  process.env.EVO_VOICE_CACHE_DIR = path.join(tmpRoot, "cache");
  process.env.EVO_VOICE_NO_BANNER = "1";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  delete process.env.EVO_VOICE_CONFIG_DIR;
  delete process.env.EVO_VOICE_CACHE_DIR;
  delete process.env.EVO_VOICE_NO_BANNER;
  delete process.env.EVO_VOICE_TENANT_IDLE_MINUTES;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function seed(lastActivityAt?: string): ConfigFile {
  const cfg: ConfigFile = {
    activeEnv: "staging",
    tenantGuardIdleMinutes: 15,
    envs: {
      staging: {
        baseUrl: ENV_DEFAULTS.staging.baseUrl,
        user: "admin@example.test",
        cookies: { "ss-id": "cookie" },
        accountId: "acc-1",
        accountName: "Acme Training",
        tenantConfirmedAt: lastActivityAt,
        lastTenantActivityAt: lastActivityAt,
      },
    },
  };
  saveConfig(cfg);
  return cfg;
}

async function run(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(args, { from: "user" });
}

describe("tenant idle guard", () => {
  it("requires explicit confirmation when a persisted profile has never been confirmed", () => {
    const cfg = seed();
    expect(tenantGuardStatus(cfg, "staging", cfg.envs.staging!)).toMatchObject({
      confirmationRequired: true,
      reason: "never-confirmed",
      idleMinutes: 15,
    });
  });

  it("expires after the configured idle interval", () => {
    const activity = new Date(Date.now() - 16 * 60_000).toISOString();
    const cfg = seed(activity);
    expect(tenantGuardStatus(cfg, "staging", cfg.envs.staging!)).toMatchObject({
      confirmationRequired: true,
      reason: "idle",
    });
  });

  it("requires the exact active tenant and persists confirmation", () => {
    seed();
    expect(() => confirmTenantContext(undefined, "Wrong Tenant")).toThrow(/does not match the active tenant/);
    const status = confirmTenantContext(undefined, "Acme Training");
    expect(status.confirmationRequired).toBe(false);
    const saved = loadConfig().envs.staging!;
    expect(saved.tenantConfirmedAt).toEqual(expect.any(String));
    expect(saved.lastTenantActivityAt).toEqual(expect.any(String));
  });

  it("blocks account-scoped commands until account confirm runs", async () => {
    seed(new Date(Date.now() - 16 * 60_000).toISOString());

    await expect(run(["flow", "list", "--quiet"])).rejects.toMatchObject({ code: EXIT.TENANT_CONFIRMATION_REQUIRED });
    expect(fetchMock).not.toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).toContain('"requiresTenantConfirmation":true');
    expect(output).toContain("Acme Training");

    await run(["account", "confirm", "Acme Training", "--quiet"]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [{ id: "flow-1" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await run(["flow", "list", "--quiet"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps local flow-file inspection available while tenant context is expired", async () => {
    seed();
    const flowFile = path.join(tmpRoot, "flow.json");
    fs.writeFileSync(flowFile, JSON.stringify({ name: "Local", parameters: [], exits: [], nodes: [] }));
    await run(["flow", "logic", "--file", flowFile]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears confirmation when switching tenants", async () => {
    seed(new Date().toISOString());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      isAuthenticated: true,
      accountIds: ["acc-1", "acc-2"],
      accountNames: ["Acme Training", "Beta Corp"],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await run(["account", "use", "Beta Corp", "--quiet"]);

    const profile = loadConfig().envs.staging!;
    expect(profile.accountId).toBe("acc-2");
    expect(profile.tenantConfirmedAt).toBeUndefined();
    expect(profile.lastTenantActivityAt).toBeUndefined();
  });

  it("refuses cross-tenant one-call account overrides while enabled", async () => {
    seed(new Date().toISOString());
    await expect(run(["flow", "list", "--account-id", "acc-2", "--quiet"]))
      .rejects.toMatchObject({ code: EXIT.TENANT_CONFIRMATION_REQUIRED });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not consume a production token when tenant confirmation expires before phase two", async () => {
    const recent = new Date().toISOString();
    const cfg = seed(recent);
    cfg.envs.prod = {
      ...cfg.envs.staging!,
      baseUrl: ENV_DEFAULTS.prod.baseUrl,
      tenantConfirmedAt: recent,
      lastTenantActivityAt: new Date(Date.now() - 16 * 60_000).toISOString(),
    };
    saveConfig(cfg);
    const now = new Date();
    const action: PendingAction = {
      token: "tenant-token",
      env: "prod",
      baseUrl: ENV_DEFAULTS.prod.baseUrl,
      accountId: "acc-1",
      accountName: "Acme Training",
      method: "PATCH",
      path: "/flows/flow-1",
      body: { description: "Updated" },
      action: "PATCH /flows/flow-1",
      summary: "Patch flow on Acme Training",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    };
    recordPending(action);

    await expect(run(["confirm", action.token, "--quiet"]))
      .rejects.toMatchObject({ code: EXIT.TENANT_CONFIRMATION_REQUIRED });
    expect(getPending(action.token).consumed).not.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    await run(["account", "confirm", "Acme Training", "--env", "prod", "--quiet"]);
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await run(["confirm", action.token, "--quiet"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("can be configured or disabled", () => {
    seed();
    expect(configureTenantGuard(30)).toEqual({ enabled: true, idleMinutes: 30 });
    expect(loadConfig().tenantGuardIdleMinutes).toBe(30);
    expect(configureTenantGuard(null)).toEqual({ enabled: false, idleMinutes: null });
    expect(tenantGuardStatus(loadConfig(), "staging", loadConfig().envs.staging!).enabled).toBe(false);
  });
});
