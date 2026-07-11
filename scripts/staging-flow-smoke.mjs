import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");
const user = process.env.EVO_VOICE_USER;
const password = process.env.EVO_VOICE_PASSWORD;
const account = process.env.EVO_VOICE_SMOKE_ACCOUNT ?? "Evo";
const sourceId = process.env.EVO_VOICE_SMOKE_SOURCE_FLOW_ID;

if (!user || !password || !sourceId) {
  process.stderr.write(
    "Set EVO_VOICE_USER, EVO_VOICE_PASSWORD, and EVO_VOICE_SMOKE_SOURCE_FLOW_ID. " +
    "The harness only writes a disposable EVOV-CLI-SMOKE-* flow on staging.\n",
  );
  process.exit(2);
}
if (!fs.existsSync(cli)) {
  process.stderr.write("dist/cli.js is missing; run npm run build first.\n");
  process.exit(2);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "evov-flow-smoke-"));
const env = {
  ...process.env,
  EVO_VOICE_CONFIG_DIR: path.join(temp, "config"),
  EVO_VOICE_CACHE_DIR: path.join(temp, "cache"),
  EVO_VOICE_NO_BANNER: "1",
};
let createdId;
let blueprintName;
let summary;

function run(args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`evov ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  if (result.status !== 0) return { __failed: true, status: result.status, error: result.stderr || result.stdout };
  const stdout = result.stdout.trim();
  return stdout ? JSON.parse(stdout) : {};
}

function findEditableParameter(flow) {
  const resourceTypes = new Set([
    "AudioFile", "PhoneNumber", "Assistant", "User", "Endpoint", "File", "FaxNumber",
    "EmailAccount", "Customer", "Flow", "Team", "SipTrunk", "Transition", "List", "Struct",
  ]);
  for (const node of flow.nodes ?? []) {
    for (const [name, parameter] of Object.entries(node.parameters ?? {})) {
      if (parameter.source !== "Value" || resourceTypes.has(parameter.type)) continue;
      if (/(api.?key|auth|password|secret|token|credential)/i.test(name)) continue;
      if (parameter.type === "Number") {
        const current = Number(parameter.value?.numberValue ?? 0);
        return { nodeId: node.id, name, value: current + 1 };
      }
      if (parameter.type === "Boolean") {
        return { nodeId: node.id, name, value: !Boolean(parameter.value?.boolValue) };
      }
      if (parameter.type === "String") {
        return { nodeId: node.id, name, value: `${parameter.value?.stringValue ?? ""}-smoke` };
      }
    }
  }
  throw new Error("Source flow has no safe scalar Value parameter for the smoke edit.");
}

try {
  run(["auth", "login", "--env", "staging", "--user", user, "--password", password, "--account-name", account, "--no-input", "--quiet"]);
  const orphanResult = run(["flow", "list", "--name", "EVOV-CLI-SMOKE-", "--all", "--quiet"], { allowFailure: true });
  if (orphanResult.__failed && orphanResult.status !== 3) throw new Error(`Could not check for orphaned smoke flows: ${orphanResult.error}`);
  const orphans = orphanResult.__failed ? { items: [] } : orphanResult;
  if ((orphans.items ?? []).length > 0) {
    throw new Error(`Existing disposable smoke flows must be reviewed first: ${(orphans.items ?? []).map((flow) => `${flow.name} (${flow.id})`).join(", ")}`);
  }
  const source = run(["flow", "get", sourceId, "--quiet"]);
  const smokeName = `EVOV-CLI-SMOKE-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const createBody = {
    name: smokeName,
    description: "Disposable Evo Voice CLI staging integration smoke flow",
    notes: source.notes,
    parameters: source.parameters ?? [],
    exits: source.exits ?? [],
    nodes: source.nodes ?? [],
    roles: [],
  };
  const createFile = path.join(temp, "create-flow.json");
  fs.writeFileSync(createFile, JSON.stringify(createBody), { mode: 0o600 });
  const created = run(["flow", "create", "-f", createFile, "--quiet"]);
  createdId = created.id;
  if (!createdId) {
    const matches = run(["flow", "list", "--name", smokeName, "--all", "--quiet"]);
    createdId = matches.items?.find((flow) => flow.name === smokeName)?.id;
  }
  if (!createdId) throw new Error("Disposable flow was created but its id could not be resolved.");

  const disposable = run(["flow", "get", createdId, "--quiet"]);
  const edit = findEditableParameter(disposable);
  const value = JSON.stringify(edit.value);
  const preview = run(["flow", "node", "set", createdId, edit.nodeId, edit.name, "--value", value, "--preview", "--quiet"]);
  if (!preview.valid || preview.diff?.equal) throw new Error("Targeted edit preview was invalid or produced no change.");
  const applied = run(["flow", "node", "set", createdId, edit.nodeId, edit.name, "--value", value, "--quiet"]);
  if (!applied.result?.verified) throw new Error("Targeted edit did not report post-write verification.");

  const validation = run(["flow", "validate", createdId, "--quiet"]);
  if (!validation.valid) throw new Error("Disposable flow failed validation after the edit.");
  const impact = run(["flow", "impact", createdId, "--quiet"]);

  blueprintName = `smoke-${createdId.slice(0, 8)}`;
  run(["flow", "blueprint", "save", blueprintName, createdId, "--revision", "1", "--quiet"]);
  const blueprint = run(["flow", "blueprint", "show", blueprintName, "--revision", "1", "--quiet"]);

  summary = {
    ok: true,
    account,
    disposableFlow: { id: createdId, name: smokeName },
    edit: { node: edit.nodeId, parameter: edit.name, verified: true },
    impact: { callers: impact.invokedByFlows?.length ?? 0, endpoints: impact.assignedEndpoints?.length ?? 0 },
    blueprint: { name: blueprintName, revision: blueprint.revision },
  };
} finally {
  let cleanupError;
  if (blueprintName) {
    const removal = run(["flow", "blueprint", "remove", blueprintName, "--revision", "1", "--force", "--quiet"], { allowFailure: true });
    if (removal.__failed) process.stderr.write(`Blueprint cleanup failed: ${removal.error}\n`);
  }
  if (createdId) {
    const deletion = run(["flow", "delete", createdId, "--force", "--quiet"], { allowFailure: true });
    if (deletion.__failed) cleanupError = new Error(`Disposable flow cleanup failed: ${deletion.error}`);
    else {
      const check = run(["flow", "get", createdId, "--quiet"], { allowFailure: true });
      if (!check.__failed) cleanupError = new Error(`Disposable flow ${createdId} still exists after cleanup.`);
    }
  }
  fs.rmSync(temp, { recursive: true, force: true });
  if (cleanupError) throw cleanupError;
}

if (summary) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
