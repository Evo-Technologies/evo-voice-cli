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

interface ListOpts {
  page?: string;
  countPerPage?: string;
  all?: boolean;
  simplifiedPaging?: boolean;
  sortField?: string;
  sortOrder?: "asc" | "desc";
  customerId?: string[];
  flowId?: string[];
  type?: string;
  tagId?: string[];
  name?: string;
  phoneNumber?: string;
  sipUserName?: string;
  userMode?: string;
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
    .option("--flow-id <id>", "Filter by flow id (repeatable)", collect, [] as string[])
    .addOption(new Option("--type <type>", "Filter by endpoint type").choices(ENDPOINT_TYPES))
    .option("--tag-id <id>", "Filter by tag id (repeatable, must contain all)", collect, [] as string[])
    .option("--name <text>", "Filter by name (contains)")
    .option("--phone-number <text>", "Filter by phone number (contains)")
    .option("--sip-user-name <text>", "Filter by SIP user name")
    .option("--user-mode <mode>", "Filter by user mode (e.g. SoftPhone, SipPhone)")
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
        flowIds: optionalList(opts.flowId),
        type: opts.type,
        tagIds: optionalList(opts.tagId),
        nameFilter: opts.name,
        phoneNumberFilter: opts.phoneNumber,
        sipUserName: opts.sipUserName,
        userMode: opts.userMode,
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
