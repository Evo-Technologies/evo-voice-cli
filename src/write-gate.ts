import crypto from "node:crypto";

import {
  isProd,
  recordPending,
  type EnvName,
  type PendingAction,
  type ResolvedEnv,
} from "./config.js";
import { CliError, EXIT } from "./exit-codes.js";
import { ssFetch } from "./http.js";
import { emit, type GlobalFlags } from "./output.js";

export interface WriteRequest {
  method: "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  query?: Record<string, string | number | string[]>;
  body?: unknown;
  /** Human-readable summary of the request, with account name in plain prose. */
  summary: string;
}

const TOKEN_BYTES = 6;        // 8 chars base64url
const TTL_MS = 5 * 60_000;    // 5 min

function newToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Runs a write request through the two-phase gate.
 *
 * - On staging: executes immediately.
 * - On prod: records the request, emits phase-1 JSON + stderr summary, exits 11.
 *
 * The exit-11 behavior is implemented by throwing CliError; the top-level
 * error handler maps it to the correct exit code.
 */
export async function executeWrite<T = unknown>(
  env: ResolvedEnv,
  cookies: Record<string, string>,
  req: WriteRequest,
  ctx: GlobalFlags,
): Promise<T | void> {
  if (isProd(env)) {
    const token = newToken();
    const now = new Date();
    const expires = new Date(now.getTime() + TTL_MS);
    const action: PendingAction = {
      token,
      env: env.name as EnvName,
      baseUrl: env.profile.baseUrl,
      accountId: env.profile.accountId,
      accountName: env.profile.accountName,
      method: req.method,
      path: req.path,
      query: req.query,
      body: req.body,
      action: `${req.method} ${req.path}`,
      summary: req.summary,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    };
    recordPending(action);

    const payload = {
      requiresConfirmation: true,
      token,
      expiresAt: action.expiresAt,
      action: action.action,
      env: action.env,
      account: action.accountName
        ? { id: action.accountId, name: action.accountName }
        : null,
      summary: req.summary,
    };

    // Emit phase-1 JSON to stdout (so agents can parse).
    emit(payload, { ...ctx, out: undefined, plain: false });

    // Human-readable copy to stderr.
    if (!ctx.quiet) {
      process.stderr.write(
        `\n⚠  PRODUCTION write requires confirmation.\n` +
        `   Action:  ${action.action}\n` +
        `   Account: ${action.accountName ?? "(unknown)"}\n` +
        `   Summary: ${req.summary}\n` +
        `\nShow the summary to the user, get explicit confirmation that this is\n` +
        `the right account and action, then run:\n` +
        `    evov confirm ${token}\n` +
        `Token expires in 5 minutes.\n`,
      );
    }

    throw new CliError(EXIT.CONFIRMATION_REQUIRED, "");
  }

  // Staging — execute directly.
  const res = await ssFetch<T>(req.method, req.path, {
    baseUrl: env.profile.baseUrl,
    cookies,
    query: req.query as Record<string, string | number | boolean | string[] | undefined> | undefined,
    body: req.body,
  });
  return res.data;
}
