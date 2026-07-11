import { Command, Option } from "commander";

import {
  loadConfig,
  requireAuthenticated,
  resolveActiveEnv,
  type EnvName,
  type ResolvedEnv,
} from "../config.js";
import { CliError, EXIT } from "../exit-codes.js";
import { planRequest, ssFetch, type SsFetchOptions } from "../http.js";
import { emit, printBanner, readBodyFromFlag, type GlobalFlags } from "../output.js";
import { executeWrite, type WriteRequest } from "../write-gate.js";

export type Query = NonNullable<SsFetchOptions["query"]>;

export interface PaginationOptions {
  page?: string;
  countPerPage?: string;
  all?: boolean;
  simplifiedPaging?: boolean;
  sortField?: string;
  sortOrder?: "asc" | "desc";
  specificId?: string[];
}

export interface CommandContext {
  globals: GlobalFlags;
  env: ResolvedEnv;
  cookies: Record<string, string>;
  user?: string;
  accountId?: string;
  accountName: string;
}

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function optionalList(values?: string[]): string[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

export function addPaginationOptions(command: Command): Command {
  return command
    .option("--page <n>", "Page number (0-based, default 0)")
    .option("--count-per-page <n>", "Items per page (default 25)")
    .option("--all", "Return all matching items (use with care)")
    .option("--simplified-paging", "Skip total/page counts for speed")
    .option("--specific-id <id>", "Restrict to exact id (repeatable)", collect, [] as string[])
    .option("--sort-field <field>", "Sort field name")
    .addOption(new Option("--sort-order <order>", "asc | desc").choices(["asc", "desc"]));
}

export function paginationQuery(options: PaginationOptions): Query {
  return {
    page: options.page,
    countPerPage: options.countPerPage,
    all: options.all,
    simplifiedPaging: options.simplifiedPaging,
    specificIds: optionalList(options.specificId),
    sortField: options.sortField,
    sortOrder: options.sortOrder === "asc"
      ? "Ascend"
      : options.sortOrder === "desc"
        ? "Descend"
        : undefined,
  };
}

export function resolveCommandContext(command: Command): CommandContext {
  const globals = command.optsWithGlobals<GlobalFlags>();
  const cfg = loadConfig();
  const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
  const profile = requireAuthenticated(env);
  return {
    globals,
    env,
    cookies: profile.cookies,
    user: profile.user,
    accountId: globals.accountId ?? env.profile.accountId,
    accountName: env.profile.accountName ?? "(unknown account)",
  };
}

export function requireAccountId(context: CommandContext): string {
  if (context.accountId) return context.accountId;
  throw new CliError(
    EXIT.USAGE,
    "No account id resolved; set --account-id or run `evov account use <nameOrId>` first.",
  );
}

export function readObjectBody(file: string | undefined): Record<string, unknown> {
  if (!file) throw new CliError(EXIT.USAGE, "--file is required");
  const body = readBodyFromFlag(file);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CliError(EXIT.USAGE, "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function withDefaultAccount(
  body: Record<string, unknown>,
  context: CommandContext,
  field = "accountId",
): Record<string, unknown> {
  if (body[field] !== undefined && body[field] !== null && body[field] !== "") return body;
  return { ...body, [field]: requireAccountId(context) };
}

export async function executeRead<T = unknown>(
  context: CommandContext,
  path: string,
  query?: Query,
  options: { emptyExit?: boolean; transform?: (data: T) => unknown } = {},
): Promise<T | undefined> {
  if (context.globals.dryRun) {
    emit(planRequest("GET", context.env.profile.baseUrl, path, { query }), context.globals);
    return undefined;
  }
  printBanner(context.env, context.globals, context.user);
  const response = await ssFetch<T>("GET", path, {
    baseUrl: context.env.profile.baseUrl,
    cookies: context.cookies,
    query,
  });
  emit(options.transform ? options.transform(response.data) : response.data, {
    ...context.globals,
    emptyExit: options.emptyExit,
  });
  return response.data;
}

export async function executeJsonWrite<T = unknown>(
  context: CommandContext,
  request: WriteRequest,
  options: { destructive?: boolean; emitResult?: boolean; planBody?: unknown } = {},
): Promise<T | void> {
  if (context.globals.dryRun) {
    emit(
      planRequest(request.method, context.env.profile.baseUrl, request.path, {
        query: request.query as Query | undefined,
        body: options.planBody ?? request.body,
      }),
      context.globals,
    );
    return;
  }

  printBanner(context.env, context.globals, context.user);
  if (options.destructive && context.env.name !== "prod" && !context.globals.force) {
    throw new CliError(EXIT.USAGE, `Refusing to ${request.summary} on staging without --force.`);
  }

  const result = await executeWrite<T>(context.env, context.cookies, request, context.globals);
  if (options.emitResult !== false) emit(result ?? { ok: true }, context.globals);
  return result;
}

export function changedKeys(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "(non-object body)";
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length > 0 ? keys.join(",") : "(empty)";
}

export function encoded(value: string): string {
  return encodeURIComponent(value);
}
