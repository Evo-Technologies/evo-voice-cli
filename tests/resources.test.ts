import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAiSessionCommand } from "../src/commands/ai-session.js";
import { buildCustomerCommand } from "../src/commands/customer.js";
import { buildConfirmCommand } from "../src/commands/confirm.js";
import { buildFileCommand } from "../src/commands/file.js";
import { buildFlowCommand } from "../src/commands/flow.js";
import { buildReportCommand } from "../src/commands/report.js";
import { buildSysCommand } from "../src/commands/sys.js";
import {
  ENV_DEFAULTS,
  pendingPath,
  saveConfig,
  type ConfigFile,
  type PendingAction,
} from "../src/config.js";
import { EXIT } from "../src/exit-codes.js";

const fetchMock = vi.fn();
let tmpRoot: string;
let stdoutSpy: { mockRestore(): void };

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evov-resources-"));
  process.env.EVO_VOICE_CONFIG_DIR = path.join(tmpRoot, "config");
  process.env.EVO_VOICE_CACHE_DIR = path.join(tmpRoot, "cache");
  process.env.EVO_VOICE_NO_BANNER = "1";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  delete process.env.EVO_VOICE_CONFIG_DIR;
  delete process.env.EVO_VOICE_CACHE_DIR;
  delete process.env.EVO_VOICE_NO_BANNER;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function seedConfig(envName: "prod" | "staging" = "staging"): void {
  const now = new Date().toISOString();
  const config: ConfigFile = {
    activeEnv: envName,
    envs: {
      [envName]: {
        baseUrl: ENV_DEFAULTS[envName].baseUrl,
        user: "user@example.test",
        cookies: { "ss-id": "cookie" },
        accountId: "acc-1",
        accountName: "Acme",
        tenantConfirmedAt: now,
        lastTenantActivityAt: now,
      },
    },
  };
  saveConfig(config);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function run(command: { exitOverride(): unknown; parseAsync(args: string[], options: { from: "user" }): Promise<unknown> }, args: string[]): Promise<void> {
  command.exitOverride();
  await command.parseAsync(args, { from: "user" });
}

describe("first-class API resource commands", () => {
  it("scopes customer lists to the active account and maps filters/paging", async () => {
    seedConfig();
    fetchMock.mockResolvedValue(jsonResponse({ items: [{ id: "cust-1" }] }));

    await run(buildCustomerCommand(), ["list", "--name", "North", "--parent-customer-id", "p1", "--page", "2"]);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/customers");
    expect(url.searchParams.get("accountIds")).toBe("acc-1");
    expect(url.searchParams.get("nameFilter")).toBe("North");
    expect(url.searchParams.get("parentCustomerIds")).toBe("p1");
    expect(url.searchParams.get("page")).toBe("2");
  });

  it("wraps exported package JSON for flow import and injects accountId", async () => {
    seedConfig();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const packagePath = path.join(tmpRoot, "package.json");
    fs.writeFileSync(packagePath, JSON.stringify({ flows: [{ name: "Main" }], customerFields: [] }));

    await run(buildFlowCommand(), ["import", "-f", packagePath]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      accountId: "acc-1",
      package: { flows: [{ name: "Main" }], customerFields: [] },
    });
  });

  it("exports account-specific flow references with portable names", async () => {
    seedConfig();
    const flow = {
      id: "flow-1",
      name: "Main",
      parameters: [],
      exits: [],
      tags: [],
      nodes: [{
        id: "start",
        isStartNode: true,
        spec: { name: "Dial", typeName: "DialNode", url: "/json/reply/DialNode" },
        parameters: {
          Team: { id: "value-1", type: "Team", source: "Value", value: { stringValue: "team-source" } },
        },
      }],
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(flow))
      .mockResolvedValueOnce(jsonResponse({ customerFields: [], endpointFields: [], systemFields: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: "team-source", type: "Team", displayName: "Support Team" }));
    const target = path.join(tmpRoot, "portable.json");

    await run(buildFlowCommand(), ["export-portable", "flow-1", "--out", target]);

    const portable = JSON.parse(fs.readFileSync(target, "utf8")) as {
      kind: string;
      references: Array<{ type: string; sourceId: string; label?: string }>;
    };
    expect(portable.kind).toBe("evov-portable-flow-package");
    expect(portable.references).toEqual([
      expect.objectContaining({ type: "Team", sourceId: "team-source", label: "Support Team" }),
    ]);
  });

  it("recursively includes invoked subflows in portable exports", async () => {
    seedConfig();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        id: "flow-main",
        name: "Main",
        parameters: [],
        exits: [],
        tags: [],
        nodes: [{
          id: "start",
          isStartNode: true,
          spec: { name: "Shared", typeName: "FlowNode", url: "/flows/start?flowId=flow-shared" },
          parameters: {},
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: "flow-shared",
        name: "Shared",
        parameters: [],
        exits: [],
        tags: [],
        nodes: [],
      }))
      .mockResolvedValueOnce(jsonResponse({ customerFields: [], endpointFields: [], systemFields: [] }));
    const target = path.join(tmpRoot, "portable-subflows.json");

    await run(buildFlowCommand(), ["export-portable", "flow-main", "--out", target]);

    const portable = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(portable.package.flows.map((flow: { id: string }) => flow.id)).toEqual(["flow-main", "flow-shared"]);
    expect(portable.references).toEqual([
      expect.objectContaining({ type: "Flow", sourceId: "flow-shared", internal: true }),
    ]);
  });

  it("preflights and rewrites portable references before backend import", async () => {
    seedConfig();
    const source = path.join(tmpRoot, "portable.json");
    fs.writeFileSync(source, JSON.stringify({
      kind: "evov-portable-flow-package",
      version: 1,
      exportedAt: "2026-07-10T00:00:00Z",
      source: { accountId: "old-account" },
      package: {
        customerFields: [],
        endpointFields: [],
        systemFields: [],
        flows: [{
          id: "flow-1",
          name: "Main",
          parameters: [],
          exits: [],
          nodes: [{
            id: "start",
            isStartNode: true,
            spec: { name: "Dial", typeName: "DialNode", url: "/json/reply/DialNode" },
            parameters: {
              Team: { id: "value-1", type: "Team", source: "Value", value: { stringValue: "team-source" } },
            },
          }],
        }],
      },
      references: [{
        type: "Team",
        sourceId: "team-source",
        label: "Support Team",
        path: ["package", "flows", 0, "nodes", 0, "parameters", "Team", "value", "stringValue"],
        location: "Main.Dial.Team",
        encoding: "value",
      }],
      warnings: [],
    }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "team-destination", type: "Team", displayName: "Support Team" }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await run(buildFlowCommand(), ["import-portable", "-f", source, "--quiet"]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const importInit = fetchMock.mock.calls[2][1] as RequestInit;
    const body = JSON.parse(String(importInit.body));
    expect(body.accountId).toBe("acc-1");
    expect(body.package.flows[0].nodes[0].parameters.Team.value.stringValue).toBe("team-destination");
  });

  it("reports custom-field conflicts before portable import writes", async () => {
    seedConfig();
    const source = path.join(tmpRoot, "portable-fields.json");
    fs.writeFileSync(source, JSON.stringify({
      kind: "evov-portable-flow-package",
      version: 1,
      exportedAt: "2026-07-10T00:00:00Z",
      source: { accountId: "old-account" },
      package: {
        customerFields: [{ name: "Tier", type: "String" }],
        endpointFields: [],
        systemFields: [],
        flows: [{ id: "flow-1", name: "Main", parameters: [], exits: [], nodes: [] }],
      },
      references: [],
      warnings: [],
    }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ customerFields: [{ name: "Tier", type: "Number" }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    const output = path.join(tmpRoot, "preflight.json");

    await run(buildFlowCommand(), ["import-portable", "-f", source, "--preflight", "--out", output, "--quiet"]);

    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(result.valid).toBe(false);
    expect(result.customFields.conflicts).toEqual([
      expect.objectContaining({ scope: "customer", name: "Tier", reason: "type mismatch" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("safely edits one node parameter by fetching, validating, and patching the complete node array", async () => {
    seedConfig();
    const flow = {
      id: "flow-1",
      name: "Main",
      parameters: [],
      exits: [],
      nodes: [{
        id: "start",
        isStartNode: true,
        spec: { name: "Wait", typeName: "WaitNode", url: "/json/reply/WaitNode" },
        parameters: { Timeout: { id: "value-1", type: "Number", source: "Value", value: { numberValue: 30 } } },
      }],
    };
    const edited = structuredClone(flow);
    edited.nodes[0].parameters.Timeout.value = { numberValue: 45 };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(flow))
      .mockResolvedValueOnce(jsonResponse(flow))
      .mockResolvedValueOnce(jsonResponse({ ...edited, updated: true }))
      .mockResolvedValueOnce(jsonResponse(edited));

    await run(buildFlowCommand(), ["node", "set", "flow-1", "start", "Timeout", "--value", "45", "--quiet"]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const patchUrl = new URL(String(fetchMock.mock.calls[2][0]));
    expect(patchUrl.pathname).toBe("/flows/flow-1");
    const body = JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body));
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].parameters.Timeout.value).toEqual({ numberValue: 45 });
  });

  it("carries flow concurrency and verification checks through production confirmation", async () => {
    seedConfig("prod");
    const flow = {
      id: "flow-1", name: "Main", parameters: [], exits: [],
      nodes: [{
        id: "start", isStartNode: true,
        spec: { name: "Wait", typeName: "WaitNode", url: "/json/reply/WaitNode" },
        parameters: { Timeout: { id: "value-1", type: "Number", source: "Value", value: { numberValue: 30 } } },
      }],
    };
    const edited = structuredClone(flow);
    edited.nodes[0].parameters.Timeout.value = { numberValue: 45 };
    fetchMock.mockResolvedValueOnce(jsonResponse(flow)).mockResolvedValueOnce(jsonResponse(flow));

    await expect(run(buildFlowCommand(), ["node", "set", "flow-1", "start", "Timeout", "--value", "45", "--quiet"]))
      .rejects.toMatchObject({ code: EXIT.CONFIRMATION_REQUIRED });
    const pending = JSON.parse(fs.readFileSync(pendingPath(), "utf8")) as { actions: Record<string, PendingAction> };
    const action = Object.values(pending.actions)[0];
    expect(action.precondition).toMatchObject({ path: "/flows/flow-1", fields: ["nodes"] });
    expect(action.verification).toMatchObject({ path: "/flows/flow-1", fields: ["nodes"] });
    expect(action.responseFields).toEqual(["id", "name"]);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(flow))
      .mockResolvedValueOnce(jsonResponse(edited))
      .mockResolvedValueOnce(jsonResponse(edited));
    await run(buildConfirmCommand(), [action.token, "--quiet"]);
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("PATCH");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("blocks a targeted edit when the flow changes between read and write", async () => {
    seedConfig();
    const flow = {
      id: "flow-1", name: "Main", parameters: [], exits: [],
      nodes: [{
        id: "start", isStartNode: true,
        spec: { name: "Wait", typeName: "WaitNode", url: "/json/reply/WaitNode" },
        parameters: { Timeout: { id: "value-1", type: "Number", source: "Value", value: { numberValue: 30 } } },
      }],
    };
    const concurrentlyEdited = structuredClone(flow);
    concurrentlyEdited.nodes[0].parameters.Timeout.value = { numberValue: 99 };
    fetchMock.mockResolvedValueOnce(jsonResponse(flow)).mockResolvedValueOnce(jsonResponse(concurrentlyEdited));

    await expect(run(buildFlowCommand(), ["node", "set", "flow-1", "start", "Timeout", "--value", "45", "--quiet"]))
      .rejects.toMatchObject({ code: EXIT.CONFLICT });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a conflict when the backend does not persist the intended graph", async () => {
    seedConfig();
    const flow = {
      id: "flow-1", name: "Main", parameters: [], exits: [],
      nodes: [{
        id: "start", isStartNode: true,
        spec: { name: "Wait", typeName: "WaitNode", url: "/json/reply/WaitNode" },
        parameters: { Timeout: { id: "value-1", type: "Number", source: "Value", value: { numberValue: 30 } } },
      }],
    };
    const edited = structuredClone(flow);
    edited.nodes[0].parameters.Timeout.value = { numberValue: 45 };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(flow))
      .mockResolvedValueOnce(jsonResponse(flow))
      .mockResolvedValueOnce(jsonResponse(edited))
      .mockResolvedValueOnce(jsonResponse(flow));

    await expect(run(buildFlowCommand(), ["node", "set", "flow-1", "start", "Timeout", "--value", "45", "--quiet"]))
      .rejects.toMatchObject({ code: EXIT.CONFLICT });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reports flow impact from callers, endpoint assignments, and outbound dependencies", async () => {
    seedConfig();
    const target = { id: "flow-target", name: "Shared", parameters: [], exits: [], nodes: [] };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(target))
      .mockResolvedValueOnce(jsonResponse({ items: [{
        id: "flow-caller",
        name: "Caller",
        nodes: [{
          id: "start",
          isStartNode: true,
          spec: { name: "Shared", typeName: "FlowNode", url: "/flows/start?flowId=flow-target" },
          parameters: {},
        }],
      }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "ep-1", type: "PhoneNumber", displayName: "Main number" }] }));
    const output = path.join(tmpRoot, "impact.json");

    await run(buildFlowCommand(), ["impact", "flow-target", "--out", output, "--quiet"]);

    const impact = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(impact.invokedByFlows).toEqual([expect.objectContaining({ id: "flow-caller" })]);
    expect(impact.assignedEndpoints).toEqual([expect.objectContaining({ id: "ep-1" })]);
    expect(impact.safeToDelete).toBe(false);
  });

  it("stores portable packages as protected local blueprints", async () => {
    seedConfig();
    const source = path.join(tmpRoot, "portable-blueprint.json");
    fs.writeFileSync(source, JSON.stringify({
      kind: "evov-portable-flow-package",
      version: 1,
      exportedAt: "2026-07-10T00:00:00Z",
      source: {},
      package: { customerFields: [], endpointFields: [], systemFields: [], flows: [{ id: "flow-1", name: "Triage", parameters: [], exits: [], nodes: [] }] },
      references: [],
      warnings: [],
    }));

    await run(buildFlowCommand(), ["blueprint", "add", "ai-triage", "-f", source, "--revision", "1.2"]);
    const saved = path.join(process.env.EVO_VOICE_CONFIG_DIR!, "blueprints", "ai-triage", "1.2.json");
    expect(fs.existsSync(saved)).toBe(true);

    const output = path.join(tmpRoot, "blueprints.json");
    await run(buildFlowCommand(), ["blueprint", "list", "--out", output]);
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual([
      expect.objectContaining({ name: "ai-triage", revision: "1.2", latest: true, flows: [{ id: "flow-1", name: "Triage" }] }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies a selected parameterized blueprint revision", async () => {
    seedConfig();
    const source = path.join(tmpRoot, "portable-parameterized.json");
    const variables = path.join(tmpRoot, "variables.json");
    fs.writeFileSync(source, JSON.stringify({
      kind: "evov-portable-flow-package", version: 1, exportedAt: "2026-07-10T00:00:00Z", source: {},
      package: { customerFields: [], endpointFields: [], systemFields: [], flows: [{ id: "flow-1", name: "Triage", description: "Default", parameters: [], exits: [], nodes: [] }] },
      references: [], warnings: [],
    }));
    fs.writeFileSync(variables, JSON.stringify([{
      name: "description",
      path: ["package", "flows", 0, "description"],
      required: true,
    }]));
    await run(buildFlowCommand(), ["blueprint", "add", "triage", "-f", source, "--revision", "2", "--variables", variables]);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await run(buildFlowCommand(), ["blueprint", "apply", "triage", "--revision", "2", "--set", "description=Customer triage", "--quiet"]);

    const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(body.package.flows[0].description).toBe("Customer triage");
  });

  it("reconciles descriptions, roles, customers, and tags after portable import", async () => {
    seedConfig();
    const source = path.join(tmpRoot, "portable-metadata.json");
    fs.writeFileSync(source, JSON.stringify({
      kind: "evov-portable-flow-package",
      version: 1,
      exportedAt: "2026-07-10T00:00:00Z",
      source: {},
      package: {
        customerFields: [], endpointFields: [], systemFields: [],
        flows: [{
          id: "source-flow", name: "Main", description: "Primary routing", roles: ["PhoneNumberRouting"],
          customerId: "source-customer", customerName: "Acme Customer",
          tags: [{ id: "source-tag", name: "Production" }], parameters: [], exits: [], nodes: [],
        }],
      },
      references: [], warnings: [],
    }));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "destination-flow", name: "Main", tags: [] }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "destination-customer", name: "Acme Customer" }] }))
      .mockResolvedValueOnce(jsonResponse({ tags: [{ id: "destination-tag", name: "Production" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: "destination-flow" }));

    await run(buildFlowCommand(), ["reconcile-portable", "-f", source, "--quiet"]);

    const body = JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body));
    expect(body).toEqual({
      description: "Primary routing",
      roles: ["PhoneNumberRouting"],
      customerId: "destination-customer",
      tagIds: ["destination-tag"],
    });
  });

  it("uploads multipart files with account/customer fields", async () => {
    seedConfig();
    fetchMock.mockResolvedValue(jsonResponse({ id: "file-1" }));
    const filePath = path.join(tmpRoot, "hello.txt");
    fs.writeFileSync(filePath, "hello world");

    await run(buildFileCommand(), ["upload", filePath, "--customer-id", "cust-1"]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("accountId")).toBe("acc-1");
    expect(form.get("customerId")).toBe("cust-1");
    const uploaded = form.get("file") as File;
    expect(uploaded.name).toBe("hello.txt");
    expect(uploaded.size).toBe(11);
  });

  it("binds exact multipart bytes into a production confirmation token", async () => {
    seedConfig("prod");
    const filePath = path.join(tmpRoot, "voice.wav");
    fs.writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));

    await expect(run(buildFileCommand(), ["upload", filePath])).rejects.toMatchObject({
      code: EXIT.CONFIRMATION_REQUIRED,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const pendingFile = JSON.parse(fs.readFileSync(pendingPath(), "utf8")) as {
      actions: Record<string, PendingAction>;
    };
    const action = Object.values(pendingFile.actions)[0];
    expect(action.path).toBe("/files");
    expect(action.body).toMatchObject({
      __evovBodyType: "multipart",
      fields: { accountId: "acc-1" },
      file: { fileName: "voice.wav", dataBase64: "AQIDBA==" },
    });

    fs.writeFileSync(filePath, Buffer.from([9, 9, 9, 9]));
    fetchMock.mockResolvedValue(jsonResponse({ id: "file-1" }));
    await run(buildConfirmCommand(), [action.token]);
    const form = fetchMock.mock.calls[0][1].body as FormData;
    const confirmedFile = form.get("file") as File;
    expect(Buffer.from(await confirmedFile.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("routes AI action deletion through destructive safeguards", async () => {
    seedConfig();
    await expect(run(buildAiSessionCommand(), ["delete-action", "ai-1", "act-2"]))
      .rejects.toMatchObject({ code: EXIT.USAGE });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await run(buildAiSessionCommand(), ["delete-action", "ai-1", "act-2", "--force"]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/ai/sessions/ai-1/actions/act-2");
  });

  it("queues typed reports with the active account", async () => {
    seedConfig();
    fetchMock.mockResolvedValue(jsonResponse({ id: "report-1", status: "Queued" }));

    await run(buildReportCommand(), [
      "run", "call-history",
      "--start-date", "2026-07-01",
      "--end-date", "2026-07-02",
      "--customer-id", "cust-1",
    ]);

    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe("/reports/call-history");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      accountId: "acc-1",
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      customerId: "cust-1",
    });
  });

  it("writes binary report downloads to --out", async () => {
    seedConfig();
    fetchMock.mockResolvedValue(new Response(Buffer.from([80, 75, 3, 4]), {
      status: 200,
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    }));
    const target = path.join(tmpRoot, "report.xlsx");

    await run(buildReportCommand(), ["download", "report-1", "--out", target]);

    expect(fs.readFileSync(target)).toEqual(Buffer.from([80, 75, 3, 4]));
  });

  it("uses the server's ServiceStack DTO route for log entries", async () => {
    seedConfig();
    fetchMock.mockResolvedValue(jsonResponse({ items: [{ id: "log-1" }] }));

    await run(buildSysCommand(), ["log-entries", "--description", "saved"]);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/json/reply/ListLogEntries");
    expect(url.searchParams.get("accountIds")).toBe("acc-1");
    expect(url.searchParams.get("description")).toBe("saved");
  });
});
