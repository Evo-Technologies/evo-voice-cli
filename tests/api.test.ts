import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApiCommand, normalizeApiPath } from "../src/commands/api.js";
import {
  ENV_DEFAULTS,
  pendingPath,
  saveConfig,
  type ConfigFile,
  type PendingAction,
} from "../src/config.js";
import { CliError, EXIT } from "../src/exit-codes.js";

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

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function run(args: string[]): Promise<void> {
  const cmd = buildApiCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: "user" });
}

describe("normalizeApiPath", () => {
  it("accepts paths with and without a leading slash", () => {
    expect(normalizeApiPath("/accounts")).toBe("/accounts");
    expect(normalizeApiPath("accounts")).toBe("/accounts");
    expect(normalizeApiPath("sessions/abc/hold")).toBe("/sessions/abc/hold");
  });

  it("rejects Git Bash-mangled Windows paths with guidance", () => {
    expect(() => normalizeApiPath("C:/Program Files/Git/accounts")).toThrowError(
      /Git Bash|MSYS_NO_PATHCONV/,
    );
  });

  it("rejects empty paths", () => {
    expect(() => normalizeApiPath("  ")).toThrowError(CliError);
  });
});

describe("api command", () => {
  it("GET sends the request with normalized path and query", async () => {
    seedConfig("staging");
    fetchMock.mockResolvedValue(okResponse({ items: [] }));

    await run(["GET", "accounts", "-q", "all=true"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`${ENV_DEFAULTS.staging.baseUrl}/accounts?all=true`);
  });

  it("GET with a body is a usage error", async () => {
    seedConfig("staging");
    await expect(run(["GET", "accounts", "-d", "{}"])).rejects.toMatchObject({
      code: EXIT.USAGE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POST on staging executes immediately with the JSON body", async () => {
    seedConfig("staging");
    fetchMock.mockResolvedValue(okResponse({ id: "cust1" }));

    await run(["POST", "customers", "-d", '{"name":"Harness"}']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ name: "Harness" });
  });

  it("POST on prod records a pending action and exits 11 without calling the API", async () => {
    seedConfig("prod");

    await expect(run(["POST", "customers", "-d", '{"name":"Harness"}'])).rejects.toMatchObject({
      code: EXIT.CONFIRMATION_REQUIRED,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const pendingFile = JSON.parse(fs.readFileSync(pendingPath(), "utf8")) as {
      actions: Record<string, PendingAction>;
    };
    const pending = Object.values(pendingFile.actions);
    expect(pending.length).toBe(1);
    expect(pending[0].method).toBe("POST");
    expect(pending[0].path).toBe("/customers");
  });

  it("DELETE requires --force even on staging", async () => {
    seedConfig("staging");

    await expect(run(["DELETE", "sessions/s1"])).rejects.toMatchObject({
      code: EXIT.USAGE,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(okResponse({}));
    await run(["DELETE", "sessions/s1", "--force"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported methods and bad --data JSON", async () => {
    seedConfig("staging");
    await expect(run(["BREW", "accounts"])).rejects.toMatchObject({ code: EXIT.USAGE });
    await expect(run(["POST", "accounts", "-d", "{oops"])).rejects.toMatchObject({
      code: EXIT.USAGE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports multipart uploads with repeatable form fields", async () => {
    seedConfig("staging");
    fetchMock.mockResolvedValue(okResponse({ id: "file1" }));
    const upload = path.join(tmpRoot, "clip.wav");
    fs.writeFileSync(upload, Buffer.from([1, 2, 3]));

    await run([
      "POST", "files",
      "--upload", upload,
      "--content-type", "audio/wav",
      "--form", "accountId=acc1",
      "--form", "customerId=cust1",
    ]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("accountId")).toBe("acc1");
    expect(form.get("customerId")).toBe("cust1");
    expect((form.get("file") as File).size).toBe(3);
  });

  it("supports binary downloads without JSON encoding", async () => {
    seedConfig("staging");
    fetchMock.mockResolvedValue(new Response(Buffer.from([80, 75, 3, 4]), { status: 200 }));
    const target = path.join(tmpRoot, "report.xlsx");

    await run(["GET", "reports/r1.xlsx", "--download", "--out", target]);

    expect(fs.readFileSync(target)).toEqual(Buffer.from([80, 75, 3, 4]));
  });
});
