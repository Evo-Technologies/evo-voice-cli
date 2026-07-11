import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ENV_DEFAULTS,
  pendingPath,
  saveConfig,
  type ConfigFile,
} from "../src/config.js";
import { EXIT } from "../src/exit-codes.js";
import { executeWrite } from "../src/write-gate.js";
import { buildSessionCommand } from "../src/commands/session.js";

const fetchMock = vi.fn();
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evov-test-"));
  process.env.EVO_VOICE_CONFIG_DIR = path.join(tmpRoot, "config");
  process.env.EVO_VOICE_CACHE_DIR = path.join(tmpRoot, "cache");
  process.env.EVO_VOICE_NO_BANNER = "1";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  delete process.env.EVO_VOICE_CONFIG_DIR;
  delete process.env.EVO_VOICE_CACHE_DIR;
  delete process.env.EVO_VOICE_NO_BANNER;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function seedConfig(envName: "prod" | "staging"): void {
  const cfg: ConfigFile = {
    activeEnv: envName,
    envs: {
      [envName]: {
        baseUrl: ENV_DEFAULTS[envName].baseUrl,
        user: "mike@evo.tech",
        cookies: { "ss-id": "abc" },
        accountId: "acc1",
        accountName: "Acme Corp",
      },
    },
  };
  saveConfig(cfg);
}

describe("executeWrite (the two-phase gate)", () => {
  it("on staging — calls the API directly", async () => {
    seedConfig("staging");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const env = {
      name: "staging" as const,
      profile: {
        baseUrl: ENV_DEFAULTS.staging.baseUrl,
        cookies: { "ss-id": "abc" },
        accountName: "Acme Corp",
        accountId: "acc1",
      },
    };
    const result = await executeWrite(env, env.profile.cookies, {
      method: "DELETE",
      path: "/sessions",
      query: { accountId: "acc1", startDateTime: "2026-05-01T00:00:00Z", endDateTime: "2026-05-02T00:00:00Z" },
      summary: "Delete sessions for Acme Corp on STAGING ...",
    }, { quiet: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/sessions");
    expect(init.method).toBe("DELETE");
    expect(result).toBeUndefined(); // 204
  });

  it("on prod — does NOT call the API, records a pending action, exits 11", async () => {
    seedConfig("prod");
    const env = {
      name: "prod" as const,
      profile: {
        baseUrl: ENV_DEFAULTS.prod.baseUrl,
        cookies: { "ss-id": "abc" },
        accountName: "Acme Corp",
        accountId: "acc1",
      },
    };

    // executeWrite throws CliError(11) instead of calling exit(11) — emit() does write to stdout
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await executeWrite(env, env.profile.cookies, {
        method: "DELETE",
        path: "/sessions",
        query: { accountId: "acc1", startDateTime: "2026-05-04T00:00:00Z", endDateTime: "2026-05-10T23:59:59Z" },
        summary: "Delete sessions for Acme Corp on PRODUCTION between 2026-05-04 and 2026-05-10",
      }, {});
      throw new Error("expected executeWrite to throw");
    } catch (err) {
      expect((err as { code?: number }).code).toBe(EXIT.CONFIRMATION_REQUIRED);
    }

    // No API call made
    expect(fetchMock).not.toHaveBeenCalled();

    // Phase-1 payload was written to stdout
    const stdoutCalls = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stdoutCalls).toContain('"requiresConfirmation":true');
    expect(stdoutCalls).toMatch(/"token":"[A-Za-z0-9_-]{6,}"/);
    expect(stdoutCalls).toContain("Acme Corp");
    expect(stdoutCalls).toContain("PRODUCTION");

    // Stderr explained the next step
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrCalls).toContain("PRODUCTION write requires confirmation");
    expect(stderrCalls).toContain("evov confirm");

    // The pending file was written
    expect(fs.existsSync(pendingPath())).toBe(true);
    const pf = JSON.parse(fs.readFileSync(pendingPath(), "utf8")) as { actions: Record<string, unknown> };
    expect(Object.keys(pf.actions)).toHaveLength(1);

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe("session active commands", () => {
  it("uses account-wide active calls for admins and keeps the user-specific endpoint explicit", async () => {
    seedConfig("staging");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ calls: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const accountWide = buildSessionCommand();
    accountWide.exitOverride();
    await accountWide.parseAsync(["active", "--quiet"], { from: "user" });
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${ENV_DEFAULTS.staging.baseUrl}/calls/active?accountId=acc1`);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const mine = buildSessionCommand();
    mine.exitOverride();
    await mine.parseAsync(["active-mine", "--quiet"], { from: "user" });
    expect(String(fetchMock.mock.calls[1][0])).toBe(`${ENV_DEFAULTS.staging.baseUrl}/sessions/active`);

    stdoutSpy.mockRestore();
  });
});
