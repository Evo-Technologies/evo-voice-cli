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
  archive?: boolean;
  startDate?: string;
  endDate?: string;
  customerId?: string[];
  endpointId?: string[];
  from?: string;
  to?: string;
  log?: string;
  parentSessionId?: string;
}

function collect(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}

export function buildSessionCommand(): Command {
  const root = new Command("session").description("Investigate and manage Evo Voice sessions (calls, chats)");

  addGlobalFlags(root.command("list"))
    .description("List sessions for the active account (GET /sessions). Returns ListResponse — jq '.items[]'.")
    .option("--page <n>", "Page number (0-based, default 0)")
    .option("--count-per-page <n>", "Items per page (default 25)")
    .option("--all", "Return all matching items (use with care)")
    .option("--simplified-paging", "Skip totals for speed; returns Items + hasMorePages")
    .option("--sort-field <field>", "Sort field name")
    .addOption(new Option("--sort-order <order>", "asc | desc").choices(["asc", "desc"]))
    .option("--archive", "Search archived sessions (>15 days old) instead of live")
    .option("--start-date <yyyy-mm-dd>", "Start date (inclusive)")
    .option("--end-date <yyyy-mm-dd>", "End date (inclusive)")
    .option("--customer-id <id>", "Filter by customer id (repeatable)", collect, [] as string[])
    .option("--endpoint-id <id>", "Filter by endpoint id (repeatable)", collect, [] as string[])
    .option("--from <text>", "Filter by from-address (contains)")
    .option("--to <text>", "Filter by to-address (contains)")
    .option("--log <text>", "Filter by text within the session log")
    .option("--parent-session-id <id>", "Filter by parent session id")
    .action(async (opts: ListOpts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags & ListOpts>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const prof = requireAuthenticated(env);

      const accountId = resolveAccountId(globals, env.profile.accountId);
      const query: Record<string, string | number | string[] | boolean | undefined> = {
        accountIds: accountId ? [accountId] : undefined,
        page: opts.page,
        countPerPage: opts.countPerPage,
        all: opts.all,
        simplifiedPaging: opts.simplifiedPaging,
        sortField: opts.sortField,
        sortOrder: opts.sortOrder === "asc" ? "Ascend" : opts.sortOrder === "desc" ? "Descend" : undefined,
        searchArchive: opts.archive,
        startDate: opts.startDate,
        endDate: opts.endDate,
        customerIds: (opts.customerId && opts.customerId.length > 0) ? opts.customerId : undefined,
        endpointIds: (opts.endpointId && opts.endpointId.length > 0) ? opts.endpointId : undefined,
        from: opts.from,
        to: opts.to,
        log: opts.log,
        parentSessionId: opts.parentSessionId,
      };

      if (globals.dryRun) {
        emit(planRequest("GET", env.profile.baseUrl, "/sessions", { query: query as Record<string, string | number | boolean | string[] | undefined> }), globals);
        return;
      }
      printBanner(env, globals, prof.user);
      const res = await ssFetch("GET", "/sessions", {
        baseUrl: env.profile.baseUrl,
        cookies: prof.cookies,
        query: query as Record<string, string | number | boolean | string[] | undefined>,
      });
      emit(res.data, { ...globals, emptyExit: true });
    });

  addGlobalFlags(root.command("get"))
    .argument("<id>", "Session id")
    .description("Fetch one session including its full log (GET /sessions/{id})")
    .action(async (id: string, _opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const prof = requireAuthenticated(env);
      if (globals.dryRun) {
        emit(planRequest("GET", env.profile.baseUrl, `/sessions/${encodeURIComponent(id)}`, {}), globals);
        return;
      }
      printBanner(env, globals, prof.user);
      const res = await ssFetch("GET", `/sessions/${encodeURIComponent(id)}`, {
        baseUrl: env.profile.baseUrl,
        cookies: prof.cookies,
      });
      emit(res.data, globals);
    });

  addGlobalFlags(root.command("log"))
    .argument("<id>", "Session id")
    .description("Fetch a session and emit just its .log array (sugar over `get | jq .log`)")
    .action(async (id: string, _opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const prof = requireAuthenticated(env);
      if (globals.dryRun) {
        emit(planRequest("GET", env.profile.baseUrl, `/sessions/${encodeURIComponent(id)}`, {}), globals);
        return;
      }
      printBanner(env, globals, prof.user);
      const res = await ssFetch<{ log?: unknown[] }>("GET", `/sessions/${encodeURIComponent(id)}`, {
        baseUrl: env.profile.baseUrl,
        cookies: prof.cookies,
      });
      emit(res.data?.log ?? [], { ...globals, emptyExit: true });
    });

  addGlobalFlags(root.command("patch"))
    .argument("<id>", "Session id")
    .description("Update a session (PATCH /sessions/{id}). Body via -f <file|->.")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (id: string, opts: { file?: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags & { file?: string }>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const prof = requireAuthenticated(env);
      if (!opts.file) throw new CliError(EXIT.USAGE, "--file is required");
      const body = readBodyFromFlag(opts.file);

      if (globals.dryRun) {
        emit(planRequest("PATCH", env.profile.baseUrl, `/sessions/${encodeURIComponent(id)}`, { body }), globals);
        return;
      }
      printBanner(env, globals, prof.user);

      const accountName = env.profile.accountName ?? "(unknown account)";
      const result = await executeWrite(env, prof.cookies, {
        method: "PATCH",
        path: `/sessions/${encodeURIComponent(id)}`,
        body,
        summary: `PATCH session ${id} on ${accountName} (${env.name}); fields: ${listChangedKeys(body)}`,
      }, globals);
      if (result !== undefined) emit(result, globals);
    });

  addGlobalFlags(root.command("delete"))
    .description("Bulk-delete sessions on an account within a date range (DELETE /sessions)")
    .option("--start-date-time <iso>", "Start datetime, ISO8601 (e.g. 2026-05-01T00:00:00Z)")
    .option("--end-date-time <iso>", "End datetime, ISO8601")
    .action(async (opts: { startDateTime?: string; endDateTime?: string }, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags & { startDateTime?: string; endDateTime?: string }>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const prof = requireAuthenticated(env);

      const accountId = resolveAccountId(globals, env.profile.accountId);
      if (!accountId) throw new CliError(EXIT.USAGE, "No account id resolved; set --account-id or `evov account use ...` first.");
      if (!opts.startDateTime || !opts.endDateTime) {
        throw new CliError(EXIT.USAGE, "--start-date-time and --end-date-time are required for `session delete`.");
      }

      const query = { accountId, startDateTime: opts.startDateTime, endDateTime: opts.endDateTime };

      if (globals.dryRun) {
        emit(planRequest("DELETE", env.profile.baseUrl, "/sessions", { query }), globals);
        return;
      }
      printBanner(env, globals, prof.user);

      // Staging: require --force (matches bvapi convention for destructive ops).
      if (env.name !== "prod" && !globals.force) {
        throw new CliError(EXIT.USAGE, "Refusing to bulk-delete sessions on staging without --force.");
      }

      const accountName = env.profile.accountName ?? "(unknown account)";
      const summary = `Delete sessions for ${accountName} on ${env.name === "prod" ? "PRODUCTION" : "STAGING"} between ${opts.startDateTime} and ${opts.endDateTime}`;
      const result = await executeWrite(env, prof.cookies, {
        method: "DELETE",
        path: "/sessions",
        query,
        summary,
      }, globals);
      if (result !== undefined) emit(result ?? { ok: true }, globals);
    });

  return root;
}

function resolveAccountId(globals: GlobalFlags, fallback?: string): string | undefined {
  if (globals.accountId) return globals.accountId;
  if (globals.accountName) {
    // Best effort: we can only validate by name during `auth login` or `account use`; here we just pass through.
    // Skill teaches: use `account use` to switch persistently. Inline override by name is rare.
    return undefined; // We don't trust name-based override at this stage; require id.
  }
  return fallback;
}

function listChangedKeys(body: unknown): string {
  if (!body || typeof body !== "object") return "(non-object body)";
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length ? keys.join(",") : "(empty)";
}
