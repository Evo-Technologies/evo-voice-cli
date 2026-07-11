import { Command, Option } from "commander";

import {
  loadConfig,
  requireAuthenticated,
  resolveActiveEnv,
  type EnvName,
} from "../config.js";
import { CliError, EXIT } from "../exit-codes.js";
import { addGlobalFlags } from "../global-flags.js";
import { planRequest, ssFetch } from "../http.js";
import { emit, printBanner, readBodyFromFlag, type GlobalFlags } from "../output.js";
import { executeWrite } from "../write-gate.js";
import {
  encoded,
  executeJsonWrite,
  executeRead,
  readObjectBody,
  requireAccountId,
  resolveCommandContext,
} from "./common.js";

interface ListOpts {
  page?: string;
  countPerPage?: string;
  all?: boolean;
  simplifiedPaging?: boolean;
  sortField?: string;
  sortOrder?: "asc" | "desc";
  customerId?: string[];
  referenceId?: string[];
  shallowParent?: boolean;
  flowId?: string[];
  flowState?: string;
  type?: string;
  endpointType?: string[];
  tagId?: string[];
  name?: string;
  phoneNumber?: string;
  sipUserName?: string;
  userMode?: string;
  dataFilter?: string[];
  flowParametersFilter?: string;
}

function collect(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}

const ENDPOINT_TYPES = [
  "PhoneNumber",
  "User",
  "Team",
  "Email",
  "Fax",
  "EmergencyAddress",
  "SipTrunk",
  "AssistantBot",
];

export function buildEndpointCommand(): Command {
  const root = new Command("endpoint").description("Manage Evo Voice endpoints (phone numbers, users, teams, SIP, etc.)");

  addGlobalFlags(root.command("list"))
    .description("List endpoints (GET /endpoints). Returns ListResponse — jq '.items[]'.")
    .option("--page <n>", "Page number (0-based, default 0)")
    .option("--count-per-page <n>", "Items per page (default 25)")
    .option("--all", "Return all matching items (use with care)")
    .option("--simplified-paging", "Skip totals for speed")
    .option("--sort-field <field>", "Sort field name")
    .addOption(new Option("--sort-order <order>", "asc | desc").choices(["asc", "desc"]))
    .option("--customer-id <id>", "Filter by customer id (repeatable)", collect, [] as string[])
    .option("--reference-id <id>", "Filter by reference id (repeatable)", collect, [] as string[])
    .option("--shallow-parent", "Only include direct customer matches")
    .option("--flow-id <id>", "Filter by flow id (repeatable)", collect, [] as string[])
    .option("--flow-state <state>", "Filter by flow state")
    .addOption(new Option("--type <type>", "Filter by endpoint type").choices(ENDPOINT_TYPES))
    .option("--endpoint-type <type>", "Filter by endpoint type (repeatable)", collect, [] as string[])
    .option("--tag-id <id>", "Filter by tag id (repeatable, must contain all)", collect, [] as string[])
    .option("--name <text>", "Filter by name (contains)")
    .option("--phone-number <text>", "Filter by phone number (contains)")
    .option("--sip-user-name <text>", "Filter by SIP user name")
    .option("--user-mode <mode>", "Filter by user mode (e.g. SoftPhone, SipPhone)")
    .option("--data-filter <field=value>", "Endpoint data filter (repeatable)", collect, [] as string[])
    .option("--flow-parameters-filter <filter>", "Flow-parameter filter expression")
    .action(async (opts: ListOpts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags & ListOpts>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const prof = requireAuthenticated(env);

      const accountId = resolveAccountId(globals, env.profile.accountId);
      const query: Record<string, string | number | boolean | string[] | undefined> = {
        accountIds: accountId ? [accountId] : undefined,
        page: opts.page,
        countPerPage: opts.countPerPage,
        all: opts.all,
        simplifiedPaging: opts.simplifiedPaging,
        sortField: opts.sortField,
        sortOrder: opts.sortOrder === "asc" ? "Ascend" : opts.sortOrder === "desc" ? "Descend" : undefined,
        customerIds: optionalList(opts.customerId),
        referenceIds: optionalList(opts.referenceId),
        shallowParent: opts.shallowParent,
        flowIds: optionalList(opts.flowId),
        flowState: opts.flowState,
        type: opts.type,
        types: optionalList(opts.endpointType),
        tagIds: optionalList(opts.tagId),
        nameFilter: opts.name,
        phoneNumberFilter: opts.phoneNumber,
        sipUserName: opts.sipUserName,
        userMode: opts.userMode,
        dataFilters: optionalList(opts.dataFilter),
        flowParametersFilter: opts.flowParametersFilter,
      };

      if (globals.dryRun) {
        emit(planRequest("GET", env.profile.baseUrl, "/endpoints", { query }), globals);
        return;
      }
      printBanner(env, globals, prof.user);
      const res = await ssFetch("GET", "/endpoints", {
        baseUrl: env.profile.baseUrl,
        cookies: prof.cookies,
        query,
      });
      emit(res.data, { ...globals, emptyExit: true });
    });

  addGlobalFlags(root.command("get"))
    .argument("<id>", "Endpoint id")
    .description("Fetch one endpoint (GET /endpoints/{id})")
    .action(async (id: string, _opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const prof = requireAuthenticated(env);
      if (globals.dryRun) {
        emit(planRequest("GET", env.profile.baseUrl, `/endpoints/${encodeURIComponent(id)}`, {}), globals);
        return;
      }
      printBanner(env, globals, prof.user);
      const res = await ssFetch("GET", `/endpoints/${encodeURIComponent(id)}`, {
        baseUrl: env.profile.baseUrl,
        cookies: prof.cookies,
      });
      emit(res.data, globals);
    });

  addGlobalFlags(root.command("patch"))
    .argument("<id>", "Endpoint id")
    .description("Update an endpoint (PATCH /endpoints/{id}). Body via -f <file|->.")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (id: string, opts: { file?: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags & { file?: string }>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const prof = requireAuthenticated(env);
      if (!opts.file) throw new CliError(EXIT.USAGE, "--file is required");
      const body = readBodyFromFlag(opts.file);

      if (globals.dryRun) {
        emit(planRequest("PATCH", env.profile.baseUrl, `/endpoints/${encodeURIComponent(id)}`, { body }), globals);
        return;
      }
      printBanner(env, globals, prof.user);

      const accountName = env.profile.accountName ?? "(unknown account)";
      const result = await executeWrite(env, prof.cookies, {
        method: "PATCH",
        path: `/endpoints/${encodeURIComponent(id)}`,
        body,
        summary: `PATCH endpoint ${id} on ${accountName} (${env.name}); fields: ${listChangedKeys(body)}`,
      }, globals);
      if (result !== undefined) emit(result, globals);
    });

  addGlobalFlags(root.command("create").alias("new"))
    .argument("<type>", "Endpoint type: user|team|email|sip-trunk|assistant|phone-number")
    .description("Create an endpoint of a specific type. Body via -f; active account is the default accountId.")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (type: string, opts: { file?: string }, command: Command) => {
      const paths: Record<string, string> = {
        user: "/endpoints/users",
        team: "/endpoints/team",
        email: "/endpoints/email",
        "sip-trunk": "/endpoints/sip-trunk",
        assistant: "/endpoints/assistant",
        "phone-number": "/endpoints/phone-numbers",
      };
      const target = paths[type.toLowerCase()];
      if (!target) throw new CliError(EXIT.USAGE, `Unknown endpoint type "${type}". Valid: ${Object.keys(paths).join(", ")}`);
      const context = resolveCommandContext(command);
      const input = readObjectBody(opts.file);
      const body = { ...input, accountId: input.accountId ?? requireAccountId(context) };
      await executeJsonWrite(context, {
        method: "POST",
        path: target,
        body,
        summary: `Create ${type} endpoint on ${context.accountName}; fields: ${listChangedKeys(body)}`,
      });
    });

  addGlobalFlags(root.command("delete"))
    .argument("<id>", "Endpoint id")
    .description("Delete an endpoint; staging requires --force")
    .action(async (id: string, _opts, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "DELETE",
        path: `/endpoints/${encoded(id)}`,
        summary: `delete endpoint ${id} from ${context.accountName}`,
      }, { destructive: true });
    });

  addGlobalFlags(root.command("search-phone-numbers"))
    .description("Search available phone numbers")
    .option("--area-code <code>", "Area code")
    .option("--country-code <code>", "Country code")
    .option("--postal-code <code>", "Postal code")
    .option("--region <name>", "Region")
    .option("--distance <n>", "Search radius")
    .option("--fax", "Search fax-capable numbers")
    .option("--contains <digits>", "Number must contain these digits")
    .action(async (opts: { areaCode?: string; countryCode?: string; postalCode?: string; region?: string; distance?: string; fax?: boolean; contains?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      await executeRead(context, "/endpoints/phone-numbers/search", {
        accountId: requireAccountId(context),
        areaCode: opts.areaCode,
        countryCode: opts.countryCode,
        postalCode: opts.postalCode,
        region: opts.region,
        distance: opts.distance,
        isFaxNumber: opts.fax,
        contains: opts.contains,
      }, { emptyExit: true });
    });

  addGlobalFlags(root.command("sync-phone-numbers"))
    .description("Synchronize phone-number endpoints from Twilio")
    .action(async (_opts, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "POST",
        path: "/phone-numbers/sync",
        body: { accountId: requireAccountId(context) },
        summary: `Synchronize phone numbers on ${context.accountName}`,
      });
    });

  addGlobalFlags(root.command("set-fax"))
    .argument("<id>", "Phone-number endpoint id")
    .description("Set whether a phone-number endpoint is a fax. Body: {\"isFax\":boolean}.")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (id: string, opts: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const body = readObjectBody(opts.file);
      await executeJsonWrite(context, {
        method: "PATCH",
        path: `/phone-numbers/${encoded(id)}/fax`,
        body,
        summary: `Set fax mode for endpoint ${id} on ${context.accountName}`,
      });
    });

  addGlobalFlags(root.command("regenerate-sip-password"))
    .argument("<id>", "SIP endpoint id")
    .description("Regenerate a SIP endpoint password")
    .action(async (id: string, _opts, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "PATCH",
        path: `/endpoints/sip/${encoded(id)}/password`,
        summary: `Regenerate SIP password for endpoint ${id} on ${context.accountName}`,
      });
    });

  addGlobalFlags(root.command("verify-caller-id"))
    .argument("<id>", "Endpoint id")
    .description("Start caller-ID verification")
    .action(async (id: string, _opts, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "POST",
        path: "/endpoints/verify-caller-id",
        body: { endpointId: id },
        summary: `Verify caller ID for endpoint ${id} on ${context.accountName}`,
      });
    });

  addGlobalFlags(root.command("duplicates"))
    .argument("<field>", "Endpoint data field name")
    .description("Find duplicate values for an endpoint data field")
    .action(async (field: string, _opts, command: Command) => {
      const context = resolveCommandContext(command);
      await executeRead(context, "/endpoints/duplicates", {
        accountId: requireAccountId(context),
        endpointFieldName: field,
      }, { emptyExit: true });
    });

  addGlobalFlags(root.command("inherited-schedule"))
    .argument("<id>", "Endpoint id")
    .description("Get an endpoint's inherited schedule")
    .action(async (id: string, _opts, command: Command) => {
      await executeRead(resolveCommandContext(command), `/endpoints/${encoded(id)}/inherited-schedule`);
    });

  addGlobalFlags(root.command("test-schedule"))
    .argument("<id>", "Endpoint id")
    .description("Evaluate a schedule for an endpoint")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (id: string, opts: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const body = readObjectBody(opts.file);
      await executeJsonWrite(context, {
        method: "POST",
        path: `/endpoints/${encoded(id)}/test-schedule`,
        body,
        summary: `Test schedule for endpoint ${id} on ${context.accountName}`,
      });
    });

  addGlobalFlags(root.command("provision-cogito"))
    .description("Provision Cogito SIP/LiveKit infrastructure for the active account")
    .action(async (_opts, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "POST",
        path: "/endpoints/cogito/provision",
        body: { accountId: requireAccountId(context) },
        summary: `Provision Cogito for ${context.accountName}`,
      });
    });

  return root;
}

function resolveAccountId(globals: GlobalFlags, fallback?: string): string | undefined {
  if (globals.accountId) return globals.accountId;
  return fallback;
}

function optionalList(arr: string[] | undefined): string[] | undefined {
  return arr && arr.length > 0 ? arr : undefined;
}

function listChangedKeys(body: unknown): string {
  if (!body || typeof body !== "object") return "(non-object body)";
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length ? keys.join(",") : "(empty)";
}
