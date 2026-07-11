import fs from "node:fs";
import path from "node:path";

import { Command, Option } from "commander";

import { configDir } from "../config.js";
import { CliError, EXIT } from "../exit-codes.js";
import { fingerprintJson, selectJsonFields } from "../fingerprint.js";
import {
  addReferenceLabels,
  applyFlowEdits,
  applyPortableResolutions,
  buildFlowLogic,
  buildPortablePackage,
  diffFlowLogic,
  findCustomFieldDependencies,
  findPortableReferences,
  resolvePortableReferences,
  validateFlowStructure,
  type FlowEditOperation,
  type FlowEditResult,
  type PortableFlowPackage,
  type PortableReference,
  type ResourceCandidate,
} from "../flow-tools.js";
import { addGlobalFlags } from "../global-flags.js";
import { planRequest, ssFetch } from "../http.js";
import { emit, printBanner, readBodyFromFlag, type GlobalFlags } from "../output.js";
import {
  addPaginationOptions,
  changedKeys,
  collect,
  encoded,
  executeJsonWrite,
  executeRead,
  optionalList,
  paginationQuery,
  readObjectBody,
  requireAccountId,
  resolveCommandContext,
  type CommandContext,
  type PaginationOptions,
} from "./common.js";

const FLOW_ROLES = ["UI", "Reference", "PhoneNumberRouting", "UserDialOut", "FaxNumberRouting"];

interface FlowListOptions extends PaginationOptions {
  customerId?: string[];
  name?: string;
  tagId?: string[];
  role?: string;
  includeNodes?: boolean;
  nodeType?: string;
}

interface BlueprintVariable {
  name: string;
  path: Array<string | number>;
  description?: string;
  required?: boolean;
  default?: unknown;
  secret?: boolean;
}

interface BlueprintEnvelope {
  kind: "evov-flow-blueprint";
  version: 1;
  name: string;
  revision: string;
  createdAt: string;
  variables: BlueprintVariable[];
  portable: PortableFlowPackage;
}

export function buildFlowCommand(): Command {
  const root = new Command("flow").description("Manage flows and portable flow packages");

  const list = addGlobalFlags(root.command("list"))
    .description("List flows for the active account (GET /flows)")
    .option("--customer-id <id>", "Filter by customer id (repeatable)", collect, [] as string[])
    .option("--name <text>", "Filter by name")
    .option("--tag-id <id>", "Require tag id (repeatable)", collect, [] as string[])
    .addOption(new Option("--role <role>", "Filter by flow role").choices(FLOW_ROLES))
    .option("--include-nodes", "Include full node definitions in list results")
    .option("--node-type <type>", "Filter by node type");
  addPaginationOptions(list).action(async (options: FlowListOptions, command: Command) => {
    const context = resolveCommandContext(command);
    await executeRead(context, "/flows", {
      ...paginationQuery(options),
      accountIds: [requireAccountId(context)],
      customerIds: optionalList(options.customerId),
      nameFilter: options.name,
      tagIds: optionalList(options.tagId),
      role: options.role,
      includeNodes: options.includeNodes,
      nodeTypeFilter: options.nodeType,
    }, { emptyExit: true });
  });

  addGlobalFlags(root.command("get"))
    .argument("<id>", "Flow id")
    .description("Fetch one flow including nodes (GET /flows/{id})")
    .action(async (id: string, _options, command: Command) => {
      await executeRead(resolveCommandContext(command), `/flows/${encoded(id)}`);
    });

  addGlobalFlags(root.command("create").alias("new"))
    .description("Create a flow (POST /flows). Body via -f <file|->; active account is the default accountId.")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (options: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const input = readObjectBody(options.file);
      const body = input.accountId ? input : { ...input, accountId: requireAccountId(context) };
      await executeJsonWrite(context, {
        method: "POST",
        path: "/flows",
        body,
        summary: `Create flow on ${context.accountName} (${context.env.name}); fields: ${changedKeys(body)}`,
      });
    });

  addGlobalFlags(root.command("patch"))
    .argument("<id>", "Flow id")
    .description("Update a flow (PATCH /flows/{id}). Body via -f <file|->.")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (id: string, options: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const body = readObjectBody(options.file);
      await executeJsonWrite(context, {
        method: "PATCH",
        path: `/flows/${encoded(id)}`,
        body,
        summary: `Patch flow ${id} on ${context.accountName}; fields: ${changedKeys(body)}`,
      });
    });

  addGlobalFlags(root.command("copy"))
    .argument("<id>", "Flow id")
    .description("Copy a flow (POST /flows/{id}/copy)")
    .action(async (id: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "POST",
        path: `/flows/${encoded(id)}/copy`,
        summary: `Copy flow ${id} on ${context.accountName}`,
      });
    });

  addGlobalFlags(root.command("delete"))
    .argument("<id>", "Flow id")
    .description("Delete a flow (DELETE /flows/{id}); staging requires --force")
    .action(async (id: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "DELETE",
        path: `/flows/${encoded(id)}`,
        summary: `delete flow ${id} from ${context.accountName}`,
      }, { destructive: true });
    });

  addGlobalFlags(root.command("export"))
    .argument("[id...]", "Flow ids (omit to export no flows and only selected custom fields)")
    .description("Export flows and custom fields as a JSON package (GET /packages)")
    .option("--no-custom-fields", "Do not include all custom fields")
    .action(async (ids: string[], options: { customFields?: boolean }, command: Command) => {
      const context = resolveCommandContext(command);
      await executeRead(context, "/packages", {
        accountId: requireAccountId(context),
        flowIds: ids.length > 0 ? ids : undefined,
        includeAllCustomFields: options.customFields !== false,
      });
    });

  addGlobalFlags(root.command("import"))
    .description("Import a JSON package produced by `flow export` (POST /packages)")
    .requiredOption("-f, --file <path>", "Package JSON file (use - for stdin)")
    .action(async (options: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const input = readObjectBody(options.file);
      const body = "package" in input
        ? { ...input, accountId: input.accountId ?? requireAccountId(context) }
        : { accountId: requireAccountId(context), package: input };
      await executeJsonWrite(context, {
        method: "POST",
        path: "/packages",
        body,
        summary: `Import flow package into ${context.accountName} (${context.env.name})`,
      });
    });

  addGlobalFlags(root.command("available-nodes"))
    .argument("[id]", "Optional flow id used to filter available nodes")
    .description("List flow node specifications (GET /flows/available-nodes)")
    .action(async (id: string | undefined, _options, command: Command) => {
      await executeRead(resolveCommandContext(command), "/flows/available-nodes", { flowId: id }, { emptyExit: true });
    });

  addGlobalFlags(root.command("parameters"))
    .description("List parameter field names for the active account")
    .option("--exclude-built-in", "Exclude built-in fields")
    .action(async (options: { excludeBuiltIn?: boolean }, command: Command) => {
      const context = resolveCommandContext(command);
      await executeRead(context, "/flows/parameters", {
        accountId: requireAccountId(context),
        excludeBuiltInFields: options.excludeBuiltIn,
      });
    });

  addGlobalFlags(root.command("logic"))
    .argument("[id]", "Flow id (omit when using --file)")
    .description("Emit a compact, secret-redacted logic graph for AI/human review")
    .option("-f, --file <path>", "Analyze a flow or portable package JSON file instead of the API")
    .option("--all-values", "Include empty/default parameter values")
    .action(async (id: string | undefined, options: { file?: string; allValues?: boolean }, command: Command) => {
      assertOneSource(id, options.file);
      if (options.file) {
        const globals = command.optsWithGlobals<GlobalFlags>();
        emit(logicForInput(readBodyFromFlag(options.file), !!options.allValues), globals);
        return;
      }
      const context = resolveCommandContext(command);
      await executeRead(context, `/flows/${encoded(id!)}`, undefined, {
        transform: (flow) => buildFlowLogic(flow, !!options.allValues),
      });
    });

  addGlobalFlags(root.command("validate"))
    .argument("[id]", "Flow id (omit when using --file)")
    .description("Validate graph structure, transitions, value IDs, portability, and sensitive literals")
    .option("-f, --file <path>", "Validate a flow or portable package JSON file instead of the API")
    .action(async (id: string | undefined, options: { file?: string }, command: Command) => {
      assertOneSource(id, options.file);
      if (options.file) {
        const globals = command.optsWithGlobals<GlobalFlags>();
        emit(validationForInput(readBodyFromFlag(options.file)), globals);
        return;
      }
      const context = resolveCommandContext(command);
      await executeRead(context, `/flows/${encoded(id!)}`, undefined, {
        transform: (flow) => validateFlowStructure(flow),
      });
    });

  addGlobalFlags(root.command("diff"))
    .argument("[left]", "Left flow id (omit with --left-file)")
    .argument("[right]", "Right flow id (omit with --right-file)")
    .description("Compare two flows using their compact, secret-redacted logic rather than raw JSON")
    .option("--left-file <path>", "Read the left flow from JSON")
    .option("--right-file <path>", "Read the right flow from JSON")
    .option("--all-values", "Include empty/default values in the comparison")
    .action(async (
      left: string | undefined,
      right: string | undefined,
      options: { leftFile?: string; rightFile?: string; allValues?: boolean },
      command: Command,
    ) => {
      assertOneSource(left, options.leftFile);
      assertOneSource(right, options.rightFile);
      const globals = command.optsWithGlobals<GlobalFlags>();
      const needsApi = !!left || !!right;
      const context = needsApi ? resolveCommandContext(command) : undefined;
      if (globals.dryRun && context) {
        emit({
          operation: "flow-logic-diff",
          requests: [left, right].filter(Boolean).map((id) => planRequest("GET", context.env.profile.baseUrl, `/flows/${encoded(id!)}`, {})),
        }, globals);
        return;
      }
      if (context) printBanner(context.env, context.globals, context.user);
      const [leftFlow, rightFlow] = await Promise.all([
        options.leftFile ? oneFlow(readBodyFromFlag(options.leftFile), "left") : fetchData(context!, `/flows/${encoded(left!)}`),
        options.rightFile ? oneFlow(readBodyFromFlag(options.rightFile), "right") : fetchData(context!, `/flows/${encoded(right!)}`),
      ]);
      emit(diffFlowLogic(leftFlow, rightFlow, !!options.allValues), globals);
    });

  const node = root.command("node").description("Safely edit individual flow nodes without hand-patching the complete graph");

  addGlobalFlags(node.command("set"))
    .argument("<flowId>", "Flow id")
    .argument("<node>", "Node id or unique label")
    .argument("<parameter>", "Parameter name")
    .requiredOption("--value <json-or-text>", "JSON scalar/value wrapper, or plain text")
    .option("--source <source>", "Also change the parameter source")
    .option("--preview", "Fetch, validate, and show the semantic diff without patching")
    .description("Set one existing node parameter value")
    .action(async (
      flowId: string,
      nodeSelector: string,
      parameter: string,
      options: { value: string; source?: string; preview?: boolean },
      command: Command,
    ) => {
      await runFlowEdit(command, flowId, [{
        op: "set",
        node: nodeSelector,
        parameter,
        value: parseLooseJson(options.value),
        source: options.source,
      }], !!options.preview);
    });

  addGlobalFlags(node.command("add"))
    .argument("<flowId>", "Flow id")
    .requiredOption("-f, --file <path>", "Node JSON file (missing node/value ids are generated)")
    .option("--preview", "Fetch, validate, and show the semantic diff without patching")
    .description("Append a node, automatically generating missing ids")
    .action(async (flowId: string, options: { file?: string; preview?: boolean }, command: Command) => {
      await runFlowEdit(command, flowId, [{ op: "add-node", node: readObjectBody(options.file) }], !!options.preview);
    });

  addGlobalFlags(node.command("remove"))
    .argument("<flowId>", "Flow id")
    .argument("<node>", "Node id or unique label")
    .option("--disconnect-incoming", "Clear transitions targeting the removed node")
    .option("--preview", "Fetch, validate, and show the semantic diff without patching")
    .description("Remove a node; inbound transitions block removal unless explicitly disconnected")
    .action(async (
      flowId: string,
      nodeSelector: string,
      options: { disconnectIncoming?: boolean; preview?: boolean },
      command: Command,
    ) => {
      await runFlowEdit(command, flowId, [{
        op: "remove-node",
        node: nodeSelector,
        disconnectIncoming: !!options.disconnectIncoming,
      }], !!options.preview);
    });

  addGlobalFlags(root.command("connect"))
    .argument("<flowId>", "Flow id")
    .argument("<node>", "Source node id or unique label")
    .argument("<transition>", "Transition parameter name")
    .argument("<target>", "Target node id/label or exit name")
    .option("--preview", "Fetch, validate, and show the semantic diff without patching")
    .description("Connect an existing transition to a validated node or exit")
    .action(async (
      flowId: string,
      nodeSelector: string,
      transition: string,
      target: string,
      options: { preview?: boolean },
      command: Command,
    ) => {
      await runFlowEdit(command, flowId, [{ op: "connect", node: nodeSelector, transition, target }], !!options.preview);
    });

  addGlobalFlags(root.command("disconnect"))
    .argument("<flowId>", "Flow id")
    .argument("<node>", "Source node id or unique label")
    .argument("<transition>", "Transition parameter name")
    .option("--preview", "Fetch, validate, and show the semantic diff without patching")
    .description("Clear an existing transition")
    .action(async (
      flowId: string,
      nodeSelector: string,
      transition: string,
      options: { preview?: boolean },
      command: Command,
    ) => {
      await runFlowEdit(command, flowId, [{ op: "disconnect", node: nodeSelector, transition }], !!options.preview);
    });

  addGlobalFlags(root.command("edit"))
    .argument("<flowId>", "Flow id")
    .requiredOption("-f, --file <path>", "JSON operation array or {operations:[...]} file")
    .option("--preview", "Fetch, validate, and show the combined semantic diff without patching")
    .description("Apply multiple targeted node edits as one validated graph PATCH")
    .action(async (flowId: string, options: { file?: string; preview?: boolean }, command: Command) => {
      await runFlowEdit(command, flowId, parseFlowEdits(readBodyFromFlag(options.file!)), !!options.preview);
    });

  addGlobalFlags(root.command("impact"))
    .argument("<id>", "Flow id")
    .description("Show flows that invoke this flow, assigned endpoints, and outbound resource dependencies")
    .action(async (id: string, _options, command: Command) => {
      await emitFlowImpact(command, id);
    });

  addGlobalFlags(root.command("export-portable"))
    .argument("<id...>", "One or more related flow ids")
    .description("Export flows despite account-specific resource references, recording a portable mapping manifest")
    .option("--no-custom-fields", "Do not include custom-field definitions")
    .option("--all-custom-fields", "Include every account custom field instead of only fields used by these flows")
    .option("--no-subflows", "Do not recursively include flows invoked through /flows/start nodes")
    .action(async (ids: string[], options: { customFields?: boolean; allCustomFields?: boolean; subflows?: boolean }, command: Command) => {
      const context = resolveCommandContext(command);
      if (context.globals.dryRun) {
        emit(portableExportPlan(context, ids, options), context.globals);
        return;
      }
      printBanner(context.env, context.globals, context.user);
      emit(await buildPortableFromApi(context, ids, options), context.globals);
    });

  addGlobalFlags(root.command("import-portable"))
    .description("Resolve a portable package against the active account, then import through the backend package endpoint")
    .requiredOption("-f, --file <path>", "Portable package JSON file (use - for stdin)")
    .option("--map <path>", "JSON object mapping source IDs or Type:Name keys to destination IDs")
    .option("--preflight", "Resolve and report mappings without importing")
    .action(async (options: { file?: string; map?: string; preflight?: boolean }, command: Command) => {
      const portable = parsePortablePackage(readBodyFromFlag(options.file!));
      const explicitMappings = options.map ? parseMappings(readBodyFromFlag(options.map)) : {};
      await runPortableImport(resolveCommandContext(command), portable, explicitMappings, !!options.preflight);
    });

  const blueprint = root.command("blueprint").description("Manage reviewed portable flow packages as reusable local blueprints");

  addGlobalFlags(blueprint.command("list"))
    .description("List locally saved flow blueprints")
    .action(async (_options, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      emit(listBlueprints(), { ...globals, emptyExit: true });
    });

  addGlobalFlags(blueprint.command("add"))
    .argument("<name>", "Blueprint name")
    .requiredOption("-f, --file <path>", "Portable package JSON file")
    .option("--revision <revision>", "Blueprint revision", "1")
    .option("--variables <path>", "JSON variable definitions")
    .description("Add a reviewed portable package to the local blueprint library")
    .action(async (name: string, options: { file?: string; revision: string; variables?: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const portable = parsePortablePackage(readBodyFromFlag(options.file!));
      const variables = options.variables ? parseBlueprintVariables(readBodyFromFlag(options.variables), portable) : [];
      const saved = saveBlueprint(name, options.revision, portable, variables, !!globals.force);
      emit({ name, revision: saved.revision, path: saved.path, variables: variablesForDisplay(variables), flows: portable.package.flows.map(flowIdentity), warnings: portable.warnings }, globals);
    });

  addGlobalFlags(blueprint.command("save"))
    .argument("<name>", "Blueprint name")
    .argument("<id...>", "Root flow ids")
    .option("--no-custom-fields", "Do not include custom-field definitions")
    .option("--all-custom-fields", "Include every account custom field")
    .option("--no-subflows", "Do not recursively include invoked subflows")
    .option("--revision <revision>", "Blueprint revision", "1")
    .option("--variables <path>", "JSON variable definitions")
    .description("Create a portable package from API flows and save it as a local blueprint")
    .action(async (
      name: string,
      ids: string[],
      options: { customFields?: boolean; allCustomFields?: boolean; subflows?: boolean; revision: string; variables?: string },
      command: Command,
    ) => {
      const context = resolveCommandContext(command);
      if (context.globals.dryRun) {
        emit(portableExportPlan(context, ids, options, "save-blueprint"), context.globals);
        return;
      }
      printBanner(context.env, context.globals, context.user);
      const portable = await buildPortableFromApi(context, ids, options);
      const variables = options.variables ? parseBlueprintVariables(readBodyFromFlag(options.variables), portable) : [];
      const saved = saveBlueprint(name, options.revision, portable, variables, !!context.globals.force);
      emit({ name, revision: saved.revision, path: saved.path, variables: variablesForDisplay(variables), flows: portable.package.flows.map(flowIdentity), warnings: portable.warnings }, context.globals);
    });

  addGlobalFlags(blueprint.command("show"))
    .argument("<name>", "Blueprint name")
    .option("--revision <revision>", "Specific revision (defaults to latest)")
    .description("Show secret-redacted compact logic and migration warnings for a blueprint")
    .action(async (name: string, options: { revision?: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const blueprintValue = readBlueprint(name, options.revision);
      emit({
        name,
        revision: blueprintValue.revision,
        path: blueprintValue.path,
        variables: variablesForDisplay(blueprintValue.variables),
        warnings: blueprintValue.portable.warnings,
        logic: logicForInput(blueprintValue.portable, false),
      }, globals);
    });

  addGlobalFlags(blueprint.command("apply"))
    .argument("<name>", "Blueprint name")
    .option("--revision <revision>", "Specific revision (defaults to latest)")
    .option("--set <name=value>", "Blueprint variable value (repeatable)", collect, [] as string[])
    .option("--map <path>", "JSON object mapping source IDs or Type:Name keys to destination IDs")
    .option("--preflight", "Resolve and report mappings without importing")
    .description("Preflight or import a saved blueprint into the active account")
    .action(async (name: string, options: { revision?: string; set?: string[]; map?: string; preflight?: boolean }, command: Command) => {
      const blueprintValue = readBlueprint(name, options.revision);
      const portable = instantiateBlueprint(blueprintValue, parseVariableAssignments(options.set ?? []));
      const explicitMappings = options.map ? parseMappings(readBodyFromFlag(options.map)) : {};
      await runPortableImport(resolveCommandContext(command), portable, explicitMappings, !!options.preflight);
    });

  addGlobalFlags(blueprint.command("remove"))
    .argument("<name>", "Blueprint name")
    .option("--revision <revision>", "Specific revision (defaults to latest)")
    .description("Remove one local blueprint revision; requires --force")
    .action(async (name: string, options: { revision?: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      if (!globals.force) throw new CliError(EXIT.USAGE, "Refusing to remove a blueprint without --force.");
      const blueprintValue = readBlueprint(name, options.revision);
      fs.unlinkSync(blueprintValue.path);
      emit({ removed: name, revision: blueprintValue.revision, path: blueprintValue.path }, globals);
    });

  addGlobalFlags(root.command("reconcile-portable"))
    .description("Restore portable metadata the backend package importer drops")
    .requiredOption("-f, --file <path>", "Portable package JSON file")
    .option("--map <path>", "Mappings for source customer/tag ids or Type:Name keys")
    .option("--flow <id-or-name>", "Reconcile one source flow (required for multi-flow production packages)")
    .option("--preview", "Show destination matches and PATCH bodies without writing")
    .action(async (
      options: { file?: string; map?: string; flow?: string; preview?: boolean },
      command: Command,
    ) => {
      const portable = parsePortablePackage(readBodyFromFlag(options.file!));
      const mappings = options.map ? parseMappings(readBodyFromFlag(options.map)) : {};
      await reconcilePortable(resolveCommandContext(command), portable, mappings, options.flow, !!options.preview);
    });

  return root;
}

async function runFlowEdit(
  command: Command,
  flowId: string,
  edits: FlowEditOperation[],
  preview: boolean,
): Promise<void> {
  const context = resolveCommandContext(command);
  if (context.globals.dryRun) {
    emit({
      operation: "flow-edit",
      edits,
      requests: [
        planRequest("GET", context.env.profile.baseUrl, `/flows/${encoded(flowId)}`, {}),
        planRequest("PATCH", context.env.profile.baseUrl, `/flows/${encoded(flowId)}`, { body: "<complete validated nodes array computed from GET>" }),
      ],
      note: "Use --preview to fetch the flow and compute a read-only validation and semantic diff.",
    }, context.globals);
    return;
  }

  printBanner(context.env, context.globals, context.user);
  const original = await fetchData(context, `/flows/${encoded(flowId)}`);
  let edit: FlowEditResult;
  try {
    edit = applyFlowEdits(original, edits);
  } catch (error) {
    throw new CliError(EXIT.USAGE, `Flow edit failed: ${(error as Error).message}`);
  }
  const view = {
    flow: flowIdentity(asRecord(original)),
    applied: false,
    operations: edit.operations,
    valid: edit.validation.valid,
    validation: edit.validation,
    diff: edit.diff,
  };
  if (!edit.validation.valid) {
    throw new CliError(
      EXIT.USAGE,
      `Flow edit produced an invalid graph: ${edit.validation.errors.map((issue) => issue.message).join("; ")}`,
    );
  }
  if (asRecord(edit.diff).equal === true) {
    emit({ ...view, noChange: true }, context.globals);
    return;
  }
  if (preview) {
    emit(view, context.globals);
    return;
  }

  const summary = asRecord(edit.diff).summary;
  const statePath = `/flows/${encoded(flowId)}`;
  const response = await executeJsonWrite(context, {
    method: "PATCH",
    path: statePath,
    body: edit.patch,
    precondition: {
      method: "GET",
      path: statePath,
      fields: ["nodes"],
      expectedHash: fingerprintJson(selectJsonFields(original, ["nodes"])),
      description: `flow ${flowId} graph`,
    },
    verification: {
      method: "GET",
      path: statePath,
      fields: ["nodes"],
      expectedHash: fingerprintJson(selectJsonFields(edit.flow, ["nodes"])),
      description: `flow ${flowId} graph`,
    },
    responseFields: ["id", "name"],
    summary: `Edit flow ${flowId} on ${context.accountName}; operations: ${edit.operations.map(editSummary).join(", ")}; semantic changes: ${JSON.stringify(summary)}`,
  }, { emitResult: false });
  const serverFlow = asRecord(response);
  emit({
    ...view,
    applied: true,
    result: Object.keys(serverFlow).length > 0 ? { ...flowIdentity(serverFlow), ok: true, verified: true } : { ok: true, verified: true },
  }, context.globals);
}

function parseLooseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function parseFlowEdits(input: unknown): FlowEditOperation[] {
  const value = Array.isArray(input) ? input : asArray(asRecord(input).operations);
  if (value.length === 0) throw new CliError(EXIT.USAGE, "Edit file must be a non-empty operation array or {operations:[...]}.");
  const allowed = new Set(["set", "connect", "disconnect", "add-node", "remove-node"]);
  return value.map((item, index) => {
    const operation = asRecord(item);
    if (!allowed.has(stringValue(operation.op))) {
      throw new CliError(EXIT.USAGE, `Unknown flow edit operation at index ${index}: ${String(operation.op)}.`);
    }
    return operation as FlowEditOperation;
  });
}

function editSummary(value: Record<string, unknown>): string {
  if (value.op === "set") return `set ${value.node}.${value.parameter}`;
  if (value.op === "connect") return `connect ${value.node}.${value.transition} -> ${value.target}`;
  if (value.op === "disconnect") return `disconnect ${value.node}.${value.transition}`;
  return `${value.op} ${value.node}`;
}

async function emitFlowImpact(command: Command, id: string): Promise<void> {
  const context = resolveCommandContext(command);
  const accountId = requireAccountId(context);
  if (context.globals.dryRun) {
    emit({
      operation: "flow-impact",
      requests: [
        planRequest("GET", context.env.profile.baseUrl, `/flows/${encoded(id)}`, {}),
        planRequest("GET", context.env.profile.baseUrl, "/flows", { query: { accountIds: [accountId], all: true, includeNodes: true } }),
        planRequest("GET", context.env.profile.baseUrl, "/endpoints", { query: { accountIds: [accountId], flowIds: [id], all: true } }),
      ],
    }, context.globals);
    return;
  }
  printBanner(context.env, context.globals, context.user);
  const [targetValue, flowValues, endpointValues] = await Promise.all([
    fetchData(context, `/flows/${encoded(id)}`),
    fetchList(context, "/flows", { accountIds: [accountId], all: true, includeNodes: true }),
    fetchList(context, "/endpoints", { accountIds: [accountId], flowIds: [id], all: true }),
  ]);
  const target = asRecord(targetValue);
  const invokedBy = flowValues.map(asRecord).flatMap((flow) => {
    const refs = findPortableReferences(flow).filter((reference) => reference.type === "Flow" && reference.sourceId === id);
    return refs.length === 0 ? [] : [{ ...flowIdentity(flow), references: refs.map((ref) => ({ location: ref.location, encoding: ref.encoding })) }];
  });
  const endpoints = endpointValues.map(asRecord).map((endpoint) => ({
    id: endpoint.id,
    name: firstString(endpoint, ["displayName", "name", "phoneNumber", "emailAddress"]),
    type: endpoint.type,
    customerId: endpoint.customerId,
  }));
  const dependencies = findPortableReferences(target).map((reference) => ({
    type: reference.type,
    id: reference.sourceId,
    label: reference.label,
    location: reference.location,
    internalSubflow: reference.encoding === "flow-url" || undefined,
  }));
  emit({
    target: flowIdentity(target),
    stats: asRecord(buildFlowLogic(target).stats),
    invokedByFlows: invokedBy,
    assignedEndpoints: endpoints,
    dependencies,
    safeToDelete: invokedBy.length === 0 && endpoints.length === 0,
    warnings: ["References embedded in arbitrary string values cannot be discovered reliably."],
  }, context.globals);
}

function portableExportPlan(
  context: CommandContext,
  ids: string[],
  options: { customFields?: boolean; subflows?: boolean },
  operation = "portable-flow-export",
): Record<string, unknown> {
  return {
    operation,
    requests: [
      ...ids.map((id) => planRequest("GET", context.env.profile.baseUrl, `/flows/${encoded(id)}`, {})),
      ...(options.customFields === false ? [] : [planRequest("GET", context.env.profile.baseUrl, "/system/settings", { query: { accountId: requireAccountId(context) } })]),
    ],
    recursivelyIncludesSubflows: options.subflows !== false,
    note: options.subflows !== false ? "Additional subflow GETs are discovered from root responses at runtime." : undefined,
  };
}

async function buildPortableFromApi(
  context: CommandContext,
  ids: string[],
  options: { customFields?: boolean; allCustomFields?: boolean; subflows?: boolean },
): Promise<PortableFlowPackage> {
  const flows = await fetchFlowClosure(context, ids, options.subflows !== false);
  const settings = options.customFields === false
    ? {}
    : asRecord(await fetchData(context, "/system/settings", { accountId: requireAccountId(context) }));
  const dependencies = findCustomFieldDependencies(flows);
  const selectFields = (key: "customerFields" | "endpointFields" | "systemFields") => {
    const all = asArray(settings[key]);
    if (options.allCustomFields) return all;
    const required = new Set(dependencies[key]);
    return all.filter((field) => required.has(stringValue(asRecord(field).name)));
  };
  let portable = buildPortablePackage(flows, {
    customerFields: selectFields("customerFields"),
    endpointFields: selectFields("endpointFields"),
    systemFields: selectFields("systemFields"),
  }, {
    accountId: context.accountId,
    accountName: context.accountName,
    env: context.env.name,
  });
  if (options.customFields !== false) {
    const included = {
      customerFields: new Set(portable.package.customerFields.map((field) => stringValue(asRecord(field).name))),
      endpointFields: new Set(portable.package.endpointFields.map((field) => stringValue(asRecord(field).name))),
      systemFields: new Set(portable.package.systemFields.map((field) => stringValue(asRecord(field).name))),
    };
    for (const key of ["customerFields", "endpointFields", "systemFields"] as const) {
      const missing = dependencies[key].filter((name) => !included[key].has(name));
      if (missing.length > 0) portable.warnings.push(`Missing ${key} definitions referenced by flows: ${missing.join(", ")}.`);
    }
  }
  portable = addReferenceLabels(portable, await sourceReferenceLabels(context, portable.references, flows, settings));
  const unnamed = portable.references.filter((reference) => !reference.internal && !reference.label);
  if (unnamed.length > 0) portable.warnings.push(`${unnamed.length} resource reference(s) could not be named and require explicit mappings.`);
  return portable;
}

function blueprintDirectory(): string {
  return path.join(configDir(), "blueprints");
}

function validateBlueprintPart(value: string, label: string, max = 81): void {
  if (!new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${max - 1}}$`).test(value)) {
    throw new CliError(EXIT.USAGE, `${label} may contain letters, numbers, dot, underscore, and dash (max ${max} characters).`);
  }
}

function blueprintPath(name: string, revision: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) {
    throw new CliError(EXIT.USAGE, "Blueprint names may contain letters, numbers, dot, underscore, and dash (max 81 characters).");
  }
  validateBlueprintPart(revision, "Blueprint revision", 41);
  return path.join(blueprintDirectory(), name, `${revision}.json`);
}

function saveBlueprint(
  name: string,
  revision: string,
  portable: PortableFlowPackage,
  variables: BlueprintVariable[],
  overwrite: boolean,
): { path: string; revision: string } {
  const target = blueprintPath(name, revision);
  if (fs.existsSync(target) && !overwrite) throw new CliError(EXIT.USAGE, `Blueprint ${name} revision ${revision} already exists; use --force to replace it.`);
  const envelope: BlueprintEnvelope = {
    kind: "evov-flow-blueprint",
    version: 1,
    name,
    revision,
    createdAt: new Date().toISOString(),
    variables,
    portable,
  };
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch { /* Windows */ }
  return { path: target, revision };
}

function blueprintRevisions(name: string): string[] {
  validateBlueprintPart(name, "Blueprint name");
  const directory = path.join(blueprintDirectory(), name);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function readBlueprint(
  name: string,
  requestedRevision?: string,
): { path: string; revision: string; variables: BlueprintVariable[]; portable: PortableFlowPackage } {
  const revisions = blueprintRevisions(name);
  const revision = requestedRevision ?? revisions.at(-1);
  if (!revision) throw new CliError(EXIT.NOT_FOUND, `Blueprint ${name} was not found.`);
  const target = blueprintPath(name, revision);
  if (!fs.existsSync(target)) throw new CliError(EXIT.NOT_FOUND, `Blueprint ${name} revision ${revision} was not found.`);
  const input = asRecord(readBodyFromFlag(target));
  if (input.kind !== "evov-flow-blueprint" || input.version !== 1) {
    throw new CliError(EXIT.CONFIG, `Blueprint ${name} revision ${revision} has an unsupported format.`);
  }
  return {
    path: target,
    revision,
    variables: parseBlueprintVariables(input.variables ?? [], parsePortablePackage(input.portable)),
    portable: parsePortablePackage(input.portable),
  };
}

function listBlueprints(): Array<Record<string, unknown>> {
  const directory = blueprintDirectory();
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    return blueprintRevisions(entry.name).map((revision) => {
      try {
        const blueprintValue = readBlueprint(entry.name, revision);
        return {
          name: entry.name,
          revision,
          latest: revision === blueprintRevisions(entry.name).at(-1),
          path: blueprintValue.path,
          variables: variablesForDisplay(blueprintValue.variables),
          flows: blueprintValue.portable.package.flows.map(flowIdentity),
          warnings: blueprintValue.portable.warnings.length,
        };
      } catch (error) {
        return { name: entry.name, revision, invalid: true, error: (error as Error).message };
      }
    });
  });
}

function parseBlueprintVariables(input: unknown, portable: PortableFlowPackage): BlueprintVariable[] {
  const values = Array.isArray(input) ? input : asArray(asRecord(input).variables);
  const names = new Set<string>();
  return values.map((item, index) => {
    const value = asRecord(item);
    const name = stringValue(value.name);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new CliError(EXIT.USAGE, `Invalid blueprint variable name at index ${index}.`);
    if (names.has(name)) throw new CliError(EXIT.USAGE, `Duplicate blueprint variable ${name}.`);
    names.add(name);
    const variablePath = asArray(value.path) as Array<string | number>;
    if (variablePath.length === 0 || variablePath[0] !== "package" || variablePath.some((part) => typeof part !== "string" && typeof part !== "number")) {
      throw new CliError(EXIT.USAGE, `Blueprint variable ${name} needs a JSON path beginning with "package".`);
    }
    if (portable.references.some((reference) => JSON.stringify(reference.path) === JSON.stringify(variablePath))) {
      throw new CliError(EXIT.USAGE, `Blueprint variable ${name} targets an account resource id; use --map instead.`);
    }
    if (getBlueprintPath(portable as unknown as Record<string, unknown>, variablePath) === undefined) {
      throw new CliError(EXIT.USAGE, `Blueprint variable ${name} path does not exist in the portable package.`);
    }
    return {
      name,
      path: variablePath,
      description: stringValue(value.description) || undefined,
      required: value.required === true || undefined,
      ...(Object.prototype.hasOwnProperty.call(value, "default") ? { default: value.default } : {}),
      secret: value.secret === true || undefined,
    };
  });
}

function parseVariableAssignments(values: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const value of values) {
    const split = value.indexOf("=");
    if (split <= 0) throw new CliError(EXIT.USAGE, `Blueprint variable assignment must be name=value: ${value}`);
    const name = value.slice(0, split);
    if (Object.prototype.hasOwnProperty.call(output, name)) throw new CliError(EXIT.USAGE, `Duplicate blueprint variable assignment ${name}.`);
    output[name] = parseLooseJson(value.slice(split + 1));
  }
  return output;
}

function instantiateBlueprint(
  blueprintValue: { variables: BlueprintVariable[]; portable: PortableFlowPackage },
  assignments: Record<string, unknown>,
): PortableFlowPackage {
  const known = new Set(blueprintValue.variables.map((variable) => variable.name));
  const unknown = Object.keys(assignments).filter((name) => !known.has(name));
  if (unknown.length > 0) throw new CliError(EXIT.USAGE, `Unknown blueprint variable(s): ${unknown.join(", ")}.`);
  const portable = JSON.parse(JSON.stringify(blueprintValue.portable)) as PortableFlowPackage;
  for (const variable of blueprintValue.variables) {
    const assigned = Object.prototype.hasOwnProperty.call(assignments, variable.name);
    const hasDefault = Object.prototype.hasOwnProperty.call(variable, "default");
    if (!assigned && !hasDefault && variable.required) throw new CliError(EXIT.USAGE, `Missing required blueprint variable --set ${variable.name}=...`);
    if (!assigned && !hasDefault) continue;
    setBlueprintPath(portable as unknown as Record<string, unknown>, variable.path, assigned ? assignments[variable.name] : variable.default);
  }
  return portable;
}

function variablesForDisplay(variables: BlueprintVariable[]): Array<Record<string, unknown>> {
  return variables.map((variable) => ({
    name: variable.name,
    path: variable.path,
    description: variable.description,
    required: variable.required,
    default: variable.secret && Object.prototype.hasOwnProperty.call(variable, "default") ? "[REDACTED]" : variable.default,
    secret: variable.secret,
  }));
}

function getBlueprintPath(root: Record<string, unknown>, jsonPath: Array<string | number>): unknown {
  let current: unknown = root;
  for (const part of jsonPath) {
    if (Array.isArray(current) && typeof part === "number") current = current[part];
    else if (current && typeof current === "object") current = (current as Record<string, unknown>)[String(part)];
    else return undefined;
  }
  return current;
}

function setBlueprintPath(root: Record<string, unknown>, jsonPath: Array<string | number>, value: unknown): void {
  let current: unknown = root;
  for (let index = 0; index < jsonPath.length - 1; index += 1) {
    const part = jsonPath[index];
    if (Array.isArray(current) && typeof part === "number") current = current[part];
    else if (current && typeof current === "object") current = (current as Record<string, unknown>)[String(part)];
    else throw new CliError(EXIT.CONFIG, `Blueprint variable path became invalid at ${jsonPath.slice(0, index + 1).join(".")}.`);
  }
  const last = jsonPath.at(-1)!;
  if (Array.isArray(current) && typeof last === "number") current[last] = value;
  else if (current && typeof current === "object") (current as Record<string, unknown>)[String(last)] = value;
  else throw new CliError(EXIT.CONFIG, `Blueprint variable path became invalid at ${jsonPath.join(".")}.`);
}

function flowIdentity(flow: Record<string, unknown>): Record<string, unknown> {
  return { id: flow.id, name: flow.name };
}

async function runPortableImport(
  context: CommandContext,
  portable: PortableFlowPackage,
  explicitMappings: Record<string, string>,
  preflightOnly: boolean,
): Promise<void> {
  if (context.globals.dryRun) {
    emit({
      operation: "portable-flow-import",
      destination: { env: context.env.name, accountId: context.accountId, accountName: context.accountName },
      flows: portable.package.flows.map(flowIdentity),
      referencesToResolve: portable.references.filter((reference) => !reference.internal).length,
      note: "Use --preflight (without --dry-run) to perform read-only destination resolution.",
      write: planRequest("POST", context.env.profile.baseUrl, "/packages", {
        body: { accountId: requireAccountId(context), package: "<resolved portable package>" },
      }),
    }, context.globals);
    return;
  }
  printBanner(context.env, context.globals, context.user);
  const [candidates, fieldCompatibility, nameConflicts] = await Promise.all([
    destinationCandidates(context, portable.references),
    destinationFieldCompatibility(context, portable),
    destinationFlowNameConflicts(context, portable.package.flows),
  ]);
  const resolutions = resolvePortableReferences(portable.references, candidates, explicitMappings);
  const blocking = resolutions.filter((resolution) => resolution.status === "unresolved" || resolution.status === "ambiguous");
  const sourceValidation = validatePortableSource(portable.package.flows);
  const preflight = {
    valid: sourceValidation.valid && blocking.length === 0 && fieldCompatibility.conflicts.length === 0 && nameConflicts.length === 0,
    destination: { env: context.env.name, accountId: context.accountId, accountName: context.accountName },
    flows: portable.package.flows.map(flowIdentity),
    resolutions: resolutions.map((resolution) => ({
      type: resolution.reference.type,
      sourceId: resolution.reference.sourceId,
      label: resolution.reference.label,
      location: resolution.reference.location,
      status: resolution.status,
      destinationId: resolution.destinationId,
      candidates: resolution.candidates,
    })),
    customFields: fieldCompatibility,
    duplicateFlowNames: nameConflicts,
    sourceValidation,
    warnings: portable.warnings,
  };
  if (preflightOnly) {
    emit(preflight, context.globals);
    return;
  }
  if (!preflight.valid) {
    throw new CliError(
      EXIT.USAGE,
      `Portable import preflight failed: ${blocking.length} unresolved/ambiguous reference(s), ` +
      `${fieldCompatibility.conflicts.length} custom-field conflict(s), ${nameConflicts.length} destination name conflict(s), ` +
      `${sourceValidation.errors.length} source package error(s). Run with --preflight and provide --map <file>.`,
    );
  }
  const backendPackage = applyPortableResolutions(portable, resolutions);
  await executeJsonWrite(context, {
    method: "POST",
    path: "/packages",
    body: { accountId: requireAccountId(context), package: backendPackage },
    summary: `Import ${backendPackage.flows.length} portable flow(s) into ${context.accountName}; resolved ${resolutions.filter((item) => item.destinationId).length} resource reference(s)`,
  });
}

async function reconcilePortable(
  context: CommandContext,
  portable: PortableFlowPackage,
  mappings: Record<string, string>,
  flowSelector: string | undefined,
  preview: boolean,
): Promise<void> {
  const sourceFlows = flowSelector
    ? portable.package.flows.filter((flow) => {
      return stringValue(flow.id) === flowSelector || normalizeName(stringValue(flow.name)) === normalizeName(flowSelector);
    })
    : portable.package.flows;
  if (sourceFlows.length === 0) throw new CliError(EXIT.NOT_FOUND, `No portable flow matched ${flowSelector}.`);
  if (sourceFlows.length > 1 && flowSelector) throw new CliError(EXIT.USAGE, `Flow selector ${flowSelector} is ambiguous.`);
  const accountId = requireAccountId(context);
  if (context.globals.dryRun) {
    emit({
      operation: "reconcile-portable-flow-metadata",
      sourceFlows: sourceFlows.map(flowIdentity),
      requests: [
        planRequest("GET", context.env.profile.baseUrl, "/flows", { query: { accountIds: [accountId], all: true } }),
        planRequest("GET", context.env.profile.baseUrl, "/customers", { query: { accountIds: [accountId], all: true } }),
        planRequest("GET", context.env.profile.baseUrl, "/system/settings", { query: { accountId } }),
        planRequest("PATCH", context.env.profile.baseUrl, "/flows/<matched-id>", { body: "<description/roles/customerId/tagIds>" }),
      ],
      note: "Use --preview to resolve destination metadata and produce exact read-only patch plans.",
    }, context.globals);
    return;
  }
  printBanner(context.env, context.globals, context.user);
  const [destinationValues, customerValues, settingsValue] = await Promise.all([
    fetchList(context, "/flows", { accountIds: [accountId], all: true }),
    sourceFlows.some((flow) => !!stringValue(flow.customerId))
      ? fetchList(context, "/customers", { accountIds: [accountId], all: true })
      : [],
    sourceFlows.some((flow) => asArray(flow.tags).length > 0)
      ? fetchData(context, "/system/settings", { accountId })
      : {},
  ]);
  const destinationFlows = destinationValues.map(asRecord);
  const customers = customerValues.map(asRecord);
  const tags = collectDestinationTags(destinationFlows, asRecord(settingsValue));
  const blockers: Array<Record<string, unknown>> = [];
  const plans: Array<{ source: Record<string, unknown>; destination: Record<string, unknown>; body: Record<string, unknown> }> = [];

  for (const source of sourceFlows) {
    const matches = destinationFlows.filter((flow) => normalizeName(stringValue(flow.name)) === normalizeName(stringValue(source.name)));
    if (matches.length !== 1) {
      blockers.push({
        flow: flowIdentity(source),
        reason: matches.length === 0 ? "destination flow not found by exact name" : "destination flow name is ambiguous",
        candidates: matches.map(flowIdentity),
      });
      continue;
    }
    const body: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(source, "description")) body.description = source.description;
    if (Array.isArray(source.roles)) body.roles = source.roles;

    const sourceCustomerId = stringValue(source.customerId);
    if (sourceCustomerId) {
      const customerName = stringValue(source.customerName);
      const resolution = resolveMetadataId("Customer", sourceCustomerId, customerName, customers, mappings);
      if (!resolution.id) blockers.push({ flow: flowIdentity(source), resource: "Customer", sourceId: sourceCustomerId, label: customerName, reason: resolution.reason });
      else body.customerId = resolution.id;
    }

    const tagIds: string[] = [];
    for (const tagValue of asArray(source.tags)) {
      const tag = asRecord(tagValue);
      const sourceTagId = stringValue(tag.id);
      const tagName = firstString(tag, ["name", "displayName"]) ?? "";
      const resolution = resolveMetadataId("Tag", sourceTagId, tagName, tags, mappings);
      if (!resolution.id) blockers.push({ flow: flowIdentity(source), resource: "Tag", sourceId: sourceTagId, label: tagName, reason: resolution.reason });
      else tagIds.push(resolution.id);
    }
    if (asArray(source.tags).length > 0) body.tagIds = tagIds;
    plans.push({ source, destination: matches[0], body });
  }

  const result = {
    valid: blockers.length === 0,
    destination: { env: context.env.name, accountId, accountName: context.accountName },
    patches: plans.map((plan) => ({ source: flowIdentity(plan.source), destination: flowIdentity(plan.destination), body: plan.body })),
    blockers,
    note: "Only metadata exposed by PATCH /flows is restored; importer-generated ids and UI-only state are unchanged.",
  };
  if (preview) {
    emit(result, context.globals);
    return;
  }
  if (blockers.length > 0) throw new CliError(EXIT.USAGE, `Metadata reconciliation has ${blockers.length} blocker(s); rerun with --preview and provide --map.`);
  const nonEmpty = plans.filter((plan) => Object.keys(plan.body).length > 0);
  if (context.env.name === "prod" && nonEmpty.length > 1) {
    throw new CliError(EXIT.USAGE, "Production reconciliation handles one flow per confirmation; rerun with --flow <source-id-or-name>.");
  }
  const applied: Array<Record<string, unknown>> = [];
  for (const plan of nonEmpty) {
    const destinationId = stringValue(plan.destination.id);
    const response = await executeJsonWrite(context, {
      method: "PATCH",
      path: `/flows/${encoded(destinationId)}`,
      body: plan.body,
      summary: `Restore imported metadata for flow ${stringValue(plan.destination.name)} (${destinationId}) on ${context.accountName}; fields: ${Object.keys(plan.body).join(",")}`,
    }, { emitResult: false });
    applied.push({
      destination: flowIdentity(plan.destination),
      fields: Object.keys(plan.body),
      result: { ...flowIdentity(asRecord(response)), ok: true },
    });
  }
  emit({ ...result, applied }, context.globals);
}

function collectDestinationTags(flows: Record<string, unknown>[], settings: Record<string, unknown>): Record<string, unknown>[] {
  const values = [
    ...flows.flatMap((flow) => asArray(flow.tags)),
    ...asArray(settings.tags),
    ...asArray(settings.flowTags),
  ].map(asRecord);
  const seen = new Set<string>();
  return values.filter((tag) => {
    const id = stringValue(tag.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function resolveMetadataId(
  type: string,
  sourceId: string,
  label: string,
  candidates: Record<string, unknown>[],
  mappings: Record<string, string>,
): { id?: string; reason?: string } {
  const explicit = mappings[sourceId] ?? (label ? mappings[`${type}:${label}`] : undefined);
  if (explicit) return { id: explicit };
  if (!label) return { reason: "no label and no explicit mapping" };
  const matches = candidates.filter((candidate) => {
    return ["name", "displayName", "referenceId"].some((field) => normalizeName(stringValue(candidate[field])) === normalizeName(label));
  });
  if (matches.length === 1) return { id: stringValue(matches[0].id) };
  return { reason: matches.length === 0 ? "no exact-name destination match" : "ambiguous exact-name destination matches" };
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function assertOneSource(id?: string, file?: string): void {
  if (!!id === !!file) throw new CliError(EXIT.USAGE, "Provide exactly one flow id or --file <path>");
}

function logicForInput(input: unknown, includeDefaults: boolean): unknown {
  const flows = extractFlows(input);
  if (flows.length === 1) return buildFlowLogic(flows[0], includeDefaults);
  return {
    format: "evov-flow-logic-set",
    version: 1,
    flows: flows.map((flow) => buildFlowLogic(flow, includeDefaults)),
  };
}

function validationForInput(input: unknown): unknown {
  const flows = extractFlows(input);
  const results = flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    ...validateFlowStructure(flow),
  }));
  return flows.length === 1
    ? results[0]
    : { valid: results.every((result) => result.valid), flows: results };
}

function validatePortableSource(flows: Record<string, unknown>[]): {
  valid: boolean;
  errors: Array<{ code: string; message: string }>;
  flows: Array<{ id: unknown; name: unknown; valid: boolean; errors: unknown[]; warnings: unknown[] }>;
} {
  const errors: Array<{ code: string; message: string }> = [];
  const names = flows.map((flow) => stringValue(flow.name).trim().toLowerCase());
  const ids = flows.map((flow) => stringValue(flow.id));
  for (const name of duplicateStrings(names.filter(Boolean))) {
    errors.push({ code: "DUPLICATE_FLOW_NAME", message: `Portable package contains duplicate flow name ${name}.` });
  }
  for (const id of duplicateStrings(ids.filter(Boolean))) {
    errors.push({ code: "DUPLICATE_FLOW_ID", message: `Portable package contains duplicate flow id ${id}.` });
  }
  for (const [index, flow] of flows.entries()) {
    if (!stringValue(flow.id)) errors.push({ code: "FLOW_ID_REQUIRED", message: `Portable flow at index ${index} has no source id.` });
    if (!stringValue(flow.name)) errors.push({ code: "FLOW_NAME_REQUIRED", message: `Portable flow at index ${index} has no name.` });
  }
  const results = flows.map((flow) => {
    const result = validateFlowStructure(flow);
    return { id: flow.id, name: flow.name, valid: result.valid, errors: result.errors, warnings: result.warnings };
  });
  return {
    valid: errors.length === 0 && results.every((result) => result.valid),
    errors: [
      ...errors,
      ...results.flatMap((result) => result.errors.map((error) => ({
        code: String(asRecord(error).code ?? "FLOW_VALIDATION"),
        message: `${String(result.name ?? result.id)}: ${String(asRecord(error).message ?? "invalid flow")}`,
      }))),
    ],
    flows: results,
  };
}

function extractFlows(input: unknown): Record<string, unknown>[] {
  const object = asRecord(input);
  if (object.kind === "evov-portable-flow-package") {
    return asArray(asRecord(object.package).flows).map(asRecord);
  }
  if (Array.isArray(object.flows)) return object.flows.map(asRecord);
  if (Array.isArray(object.items)) return object.items.map(asRecord);
  if (Object.keys(object).length > 0) return [object];
  throw new CliError(EXIT.USAGE, "Input does not contain a flow or flow package");
}

function oneFlow(input: unknown, side: string): Record<string, unknown> {
  const flows = extractFlows(input);
  if (flows.length !== 1) throw new CliError(EXIT.USAGE, `${side} input must contain exactly one flow; found ${flows.length}`);
  return flows[0];
}

function parsePortablePackage(input: unknown): PortableFlowPackage {
  const object = asRecord(input);
  if (object.kind !== "evov-portable-flow-package" || object.version !== 1) {
    throw new CliError(EXIT.USAGE, "Expected an evov-portable-flow-package version 1 file");
  }
  const backendPackage = asRecord(object.package);
  if (!Array.isArray(backendPackage.flows) || backendPackage.flows.length === 0) {
    throw new CliError(EXIT.USAGE, "Portable package contains no flows");
  }
  if (!Array.isArray(object.references)) throw new CliError(EXIT.USAGE, "Portable package has no reference manifest");
  return input as PortableFlowPackage;
}

function parseMappings(input: unknown): Record<string, string> {
  const object = asRecord(input);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(object)) {
    if (typeof value !== "string" || !value) throw new CliError(EXIT.USAGE, `Mapping ${key} must have a destination id string`);
    output[key] = value;
  }
  return output;
}

async function fetchData(
  context: CommandContext,
  path: string,
  query?: Record<string, string | number | boolean | string[] | undefined>,
): Promise<unknown> {
  const response = await ssFetch("GET", path, {
    baseUrl: context.env.profile.baseUrl,
    cookies: context.cookies,
    query,
  });
  return response.data;
}

async function fetchFlowClosure(
  context: CommandContext,
  rootIds: string[],
  includeSubflows: boolean,
): Promise<unknown[]> {
  const flows: unknown[] = [];
  const queued = [...rootIds];
  const seen = new Set<string>();
  while (queued.length > 0) {
    const id = queued.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const flow = await fetchData(context, `/flows/${encoded(id)}`);
    flows.push(flow);
    if (!includeSubflows) continue;
    for (const reference of findPortableReferences(flow)) {
      if (reference.type === "Flow" && reference.encoding === "flow-url" && !seen.has(reference.sourceId)) {
        queued.push(reference.sourceId);
      }
    }
  }
  return flows;
}

async function sourceReferenceLabels(
  context: CommandContext,
  references: PortableReference[],
  flows: unknown[],
  settings: Record<string, unknown>,
): Promise<Record<string, string | undefined>> {
  const labels: Record<string, string | undefined> = {};
  const flowById = new Map(flows.map((flow) => {
    const object = asRecord(flow);
    return [String(object.id ?? ""), String(object.name ?? "")];
  }));
  const emailAccounts = asArray(settings.emailAccounts).map(asRecord);
  const pending = new Map<string, Promise<string | undefined>>();

  for (const ref of references) {
    const key = `${ref.type}:${ref.sourceId}`;
    if (ref.label) {
      labels[key] = ref.label;
      continue;
    }
    if (ref.type === "Flow" && flowById.has(ref.sourceId)) {
      labels[key] = flowById.get(ref.sourceId);
      continue;
    }
    if (ref.type === "EmailAccount") {
      const account = emailAccounts.find((item) => item.id === ref.sourceId);
      labels[key] = account ? firstString(account, ["displayName", "emailAddress", "userName"]) : undefined;
      continue;
    }
    if (!pending.has(key)) pending.set(key, lookupSourceReference(context, ref));
  }
  await Promise.all([...pending.entries()].map(async ([key, promise]) => {
    labels[key] = await promise;
  }));
  return labels;
}

async function lookupSourceReference(context: CommandContext, ref: PortableReference): Promise<string | undefined> {
  const endpointTypes = new Set(["PhoneNumber", "Assistant", "User", "Endpoint", "FaxNumber", "Team", "SipTrunk"]);
  let route: string | undefined;
  if (endpointTypes.has(ref.type)) route = `/endpoints/${encoded(ref.sourceId)}`;
  else if (ref.type === "File" || ref.type === "AudioFile") route = `/files/${encoded(ref.sourceId)}`;
  else if (ref.type === "Customer") route = `/customers/${encoded(ref.sourceId)}`;
  else if (ref.type === "Flow") route = `/flows/${encoded(ref.sourceId)}`;
  if (!route) return undefined;
  try {
    const resource = asRecord(await fetchData(context, route));
    return firstString(resource, ["displayName", "name", "fileName", "phoneNumber", "emailAddress", "sipUserName"]);
  } catch {
    return undefined;
  }
}

async function destinationCandidates(
  context: CommandContext,
  references: PortableReference[],
): Promise<ResourceCandidate[]> {
  const requiredTypes = new Set(references.filter((ref) => !ref.internal).map((ref) => ref.type));
  const accountId = requireAccountId(context);
  const candidates: ResourceCandidate[] = [];
  const endpointTypes = new Set(["PhoneNumber", "Assistant", "User", "Endpoint", "FaxNumber", "Team", "SipTrunk"]);

  const [endpoints, files, customers, flows, settings] = await Promise.all([
    [...requiredTypes].some((type) => endpointTypes.has(type))
      ? fetchList(context, "/endpoints", { accountIds: [accountId], all: true })
      : [],
    requiredTypes.has("File") || requiredTypes.has("AudioFile")
      ? fetchList(context, "/files", { accountIds: [accountId], all: true })
      : [],
    requiredTypes.has("Customer")
      ? fetchList(context, "/customers", { accountIds: [accountId], all: true })
      : [],
    requiredTypes.has("Flow")
      ? fetchList(context, "/flows", { accountIds: [accountId], all: true })
      : [],
    requiredTypes.has("EmailAccount")
      ? fetchData(context, "/system/settings", { accountId })
      : {},
  ]);

  for (const item of endpoints.map(asRecord)) {
    const id = stringValue(item.id);
    if (!id) continue;
    candidates.push({
      id,
      type: stringValue(item.type) || "Endpoint",
      labels: stringsFrom(item, ["displayName", "name", "phoneNumber", "sipUserName", "userEmailAddress", "emailAddress", "referenceId"]),
      metadata: item,
    });
  }
  for (const item of files.map(asRecord)) addCandidate(candidates, item, "File", ["fileName"]);
  for (const item of customers.map(asRecord)) addCandidate(candidates, item, "Customer", ["name", "referenceId"]);
  for (const item of flows.map(asRecord)) addCandidate(candidates, item, "Flow", ["name"]);
  for (const item of asArray(asRecord(settings).emailAccounts).map(asRecord)) {
    addCandidate(candidates, item, "EmailAccount", ["displayName", "emailAddress", "userName"]);
  }
  return candidates;
}

async function fetchList(
  context: CommandContext,
  path: string,
  query: Record<string, string | number | boolean | string[] | undefined>,
): Promise<unknown[]> {
  const response = asRecord(await fetchData(context, path, query));
  return asArray(response.items);
}

async function destinationFieldCompatibility(
  context: CommandContext,
  portable: PortableFlowPackage,
): Promise<{
  compatible: Array<{ scope: string; name: string }>;
  additions: Array<{ scope: string; name: string; type?: unknown; endpointType?: unknown }>;
  conflicts: Array<{ scope: string; name: string; reason: string; source: unknown; destination: unknown }>;
}> {
  const sourceGroups = [
    { scope: "customer", key: "customerFields" as const },
    { scope: "endpoint", key: "endpointFields" as const },
    { scope: "system", key: "systemFields" as const },
  ];
  if (sourceGroups.every((group) => portable.package[group.key].length === 0)) {
    return { compatible: [], additions: [], conflicts: [] };
  }
  const settings = asRecord(await fetchData(context, "/system/settings", { accountId: requireAccountId(context) }));
  const compatible: Array<{ scope: string; name: string }> = [];
  const additions: Array<{ scope: string; name: string; type?: unknown; endpointType?: unknown }> = [];
  const conflicts: Array<{ scope: string; name: string; reason: string; source: unknown; destination: unknown }> = [];
  for (const group of sourceGroups) {
    const destination = asArray(settings[group.key]).map(asRecord);
    for (const sourceValue of portable.package[group.key]) {
      const source = asRecord(sourceValue);
      const name = stringValue(source.name);
      const existing = destination.find((field) => stringValue(field.name).toLowerCase() === name.toLowerCase());
      if (!existing) {
        additions.push({ scope: group.scope, name, type: source.type, endpointType: source.endpointType });
        continue;
      }
      if (existing.type !== source.type) {
        conflicts.push({ scope: group.scope, name, reason: "type mismatch", source: source.type, destination: existing.type });
        continue;
      }
      if (group.scope === "endpoint" && (existing.endpointType ?? null) !== (source.endpointType ?? null)) {
        conflicts.push({
          scope: group.scope,
          name,
          reason: "endpointType mismatch",
          source: source.endpointType ?? null,
          destination: existing.endpointType ?? null,
        });
        continue;
      }
      compatible.push({ scope: group.scope, name });
    }
  }
  return { compatible, additions, conflicts };
}

async function destinationFlowNameConflicts(
  context: CommandContext,
  sourceFlows: Record<string, unknown>[],
): Promise<Array<{ name: string; destinationId: string }>> {
  const destinationFlows = await fetchList(context, "/flows", {
    accountIds: [requireAccountId(context)],
    all: true,
  });
  const sourceNames = new Set(sourceFlows.map((flow) => stringValue(flow.name).toLowerCase()).filter(Boolean));
  return destinationFlows
    .map(asRecord)
    .filter((flow) => sourceNames.has(stringValue(flow.name).toLowerCase()))
    .map((flow) => ({ name: stringValue(flow.name), destinationId: stringValue(flow.id) }));
}

function addCandidate(
  output: ResourceCandidate[],
  item: Record<string, unknown>,
  type: string,
  labelFields: string[],
): void {
  const id = stringValue(item.id);
  if (!id) return;
  output.push({ id, type, labels: stringsFrom(item, labelFields), metadata: item });
}

function stringsFrom(object: Record<string, unknown>, fields: string[]): string[] {
  return [...new Set(fields.map((field) => stringValue(object[field])).filter(Boolean))];
}

function firstString(object: Record<string, unknown>, fields: string[]): string | undefined {
  return stringsFrom(object, fields)[0];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function duplicateStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}
