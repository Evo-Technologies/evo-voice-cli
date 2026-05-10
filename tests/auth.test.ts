import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ENV_DEFAULTS,
  credentialsPath,
  loadConfig,
  resolveActiveEnv,
  saveConfig,
  setEnvProfile,
  type ConfigFile,
} from "../src/config.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evov-test-"));
  process.env.EVO_VOICE_CONFIG_DIR = path.join(tmpRoot, "config");
});

afterEach(() => {
  delete process.env.EVO_VOICE_CONFIG_DIR;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("config file", () => {
  it("returns a sane default when no file exists", () => {
    const cfg = loadConfig();
    expect(cfg.activeEnv).toBe("staging");
    expect(cfg.envs.staging?.baseUrl).toBe(ENV_DEFAULTS.staging.baseUrl);
  });

  it("round-trips through save/load", () => {
    const cfg: ConfigFile = {
      activeEnv: "prod",
      envs: {
        prod: {
          baseUrl: ENV_DEFAULTS.prod.baseUrl,
          user: "mike@evo.tech",
          cookies: { "ss-id": "abc" },
          accountId: "acc1",
          accountName: "Acme Corp",
          accountChangedAt: "2026-05-10T12:00:00Z",
        },
      },
    };
    saveConfig(cfg);
    expect(fs.existsSync(credentialsPath())).toBe(true);
    const loaded = loadConfig();
    expect(loaded).toEqual(cfg);
  });

  it("writes mode 600 on POSIX", () => {
    saveConfig({ activeEnv: "staging", envs: { staging: { baseUrl: ENV_DEFAULTS.staging.baseUrl } } });
    if (process.platform !== "win32") {
      const mode = fs.statSync(credentialsPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

describe("env resolution", () => {
  it("uses persisted activeEnv by default", () => {
    saveConfig({ activeEnv: "prod", envs: { prod: { baseUrl: ENV_DEFAULTS.prod.baseUrl, user: "u" } } });
    const env = resolveActiveEnv(loadConfig());
    expect(env.name).toBe("prod");
    expect(env.profile.user).toBe("u");
  });

  it("honours an --env override without persisting it", () => {
    const cfg: ConfigFile = {
      activeEnv: "staging",
      envs: {
        staging: { baseUrl: ENV_DEFAULTS.staging.baseUrl },
        prod: { baseUrl: ENV_DEFAULTS.prod.baseUrl, user: "p" },
      },
    };
    saveConfig(cfg);
    const env = resolveActiveEnv(loadConfig(), "prod");
    expect(env.name).toBe("prod");
    expect(env.profile.user).toBe("p");
    // persisted activeEnv is unchanged
    expect(loadConfig().activeEnv).toBe("staging");
  });

  it("setEnvProfile is immutable / returns new ConfigFile", () => {
    const cfg = loadConfig();
    const next = setEnvProfile(cfg, "prod", { baseUrl: ENV_DEFAULTS.prod.baseUrl, accountId: "x" });
    expect(next.envs.prod?.accountId).toBe("x");
    // original untouched
    expect(cfg.envs.prod?.accountId).toBeUndefined();
  });
});
