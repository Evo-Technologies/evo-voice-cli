import fs from "node:fs";
import path from "node:path";

import { CliError, EXIT } from "./exit-codes.js";
import type { ResolvedEnv } from "./config.js";

export interface GlobalFlags {
  json?: boolean;
  plain?: boolean;
  select?: string;
  out?: string;
  dryRun?: boolean;
  noInput?: boolean;
  force?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  env?: string;
  accountId?: string;
  accountName?: string;
}

export interface EmitContext extends GlobalFlags {
  emptyExit?: boolean;
}

export function emit(data: unknown, ctx: EmitContext = {}): void {
  if (ctx.emptyExit && isEmptyResult(data)) {
    if (ctx.out) writeOut(ctx.out, data);
    process.exit(EXIT.EMPTY);
  }

  const projected = ctx.select ? project(data, ctx.select) : data;

  if (ctx.out) {
    const resolved = writeOut(ctx.out, projected);
    process.stdout.write(`${JSON.stringify({ path: resolved })}\n`);
    if (ctx.verbose) process.stderr.write(`wrote ${resolved}\n`);
    return;
  }

  if (ctx.plain) {
    process.stdout.write(toTsv(projected));
    return;
  }

  const isTty = process.stdout.isTTY;
  const json = isTty && !ctx.json ? JSON.stringify(projected, null, 2) : JSON.stringify(projected);
  process.stdout.write(`${json}\n`);
}

function isEmptyResult(data: unknown): boolean {
  if (Array.isArray(data) && data.length === 0) return true;
  if (data && typeof data === "object" && "items" in data && Array.isArray((data as { items: unknown[] }).items)) {
    return (data as { items: unknown[] }).items.length === 0;
  }
  return false;
}

function writeOut(target: string, data: unknown): string {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(data, null, 2));
  return resolved;
}

function project(data: unknown, fields: string): unknown {
  const keys = fields.split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return data;
  if (Array.isArray(data)) return data.map((item) => pick(item, keys));
  // For ListResponse-shaped data, project across .items[] but preserve the wrapper.
  if (data && typeof data === "object" && "items" in data && Array.isArray((data as { items: unknown[] }).items)) {
    const d = data as { items: unknown[] } & Record<string, unknown>;
    return { ...d, items: d.items.map((item) => pick(item, keys)) };
  }
  return pick(data, keys);
}

function pick(item: unknown, keys: string[]): Record<string, unknown> {
  if (item === null || typeof item !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (item as Record<string, unknown>)[k];
  return out;
}

function toTsv(data: unknown): string {
  // For ListResponse, TSV the items[].
  let rows: unknown = data;
  if (data && typeof data === "object" && "items" in data && Array.isArray((data as { items: unknown[] }).items)) {
    rows = (data as { items: unknown[] }).items;
  }
  if (Array.isArray(rows)) {
    if (rows.length === 0) return "";
    const headers = collectHeaders(rows);
    const out = rows.map((row) => headers.map((h) => tsvCell(row, h)).join("\t"));
    return `${headers.join("\t")}\n${out.join("\n")}\n`;
  }
  if (rows && typeof rows === "object") {
    const obj = rows as Record<string, unknown>;
    return `${Object.entries(obj)
      .filter(([, v]) => v === null || typeof v !== "object")
      .map(([k, v]) => `${k}\t${formatScalar(v)}`)
      .join("\n")}\n`;
  }
  return `${String(rows)}\n`;
}

function collectHeaders(rows: unknown[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === "object") {
      for (const k of Object.keys(row)) {
        const v = (row as Record<string, unknown>)[k];
        if (v === null || typeof v !== "object") seen.add(k);
      }
    }
  }
  return [...seen];
}

function tsvCell(row: unknown, key: string): string {
  if (!row || typeof row !== "object") return "";
  return formatScalar((row as Record<string, unknown>)[key]);
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.replace(/\t/g, " ").replace(/\n/g, " ");
  return String(v);
}

export function readBodyFromFlag(flag: string): unknown {
  const raw = readRaw(flag);
  if (raw.trim().length === 0) {
    throw new CliError(EXIT.USAGE, "Empty input body");
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(EXIT.USAGE, `Body is not valid JSON: ${(err as Error).message}`);
  }
}

function readRaw(flag: string): string {
  if (flag === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(flag, "utf8");
}

// Banner — printed to stderr before each request unless --quiet.

const ANSI = {
  red: "[31m",
  yellow: "[33m",
  dim: "[2m",
  reset: "[0m",
};

export function printBanner(env: ResolvedEnv, ctx: GlobalFlags, user?: string): void {
  if (ctx.quiet) return;
  if (process.env.EVO_VOICE_NO_BANNER === "1") return;

  const isTty = !!process.stderr.isTTY;
  const tag = env.name === "prod" ? "[PROD]" : "[STAGING]";
  const tagColored = !isTty
    ? tag
    : env.name === "prod"
      ? `${ANSI.red}${tag}${ANSI.reset}`
      : `${ANSI.yellow}${tag}${ANSI.reset}`;

  const accountStr = env.profile.accountName
    ? `acct=${env.profile.accountName}${env.profile.accountId ? ` (${env.profile.accountId.slice(0, 6)}…)` : ""}`
    : "acct=(none)";
  const userStr = user ?? env.profile.user ?? "(unknown)";
  const baseHost = (() => {
    try { return new URL(env.profile.baseUrl).host; } catch { return env.profile.baseUrl; }
  })();

  process.stderr.write(`${tagColored} ${baseHost} · ${accountStr} · user=${userStr}\n`);

  // Active-account-recently-changed warning (5 min window)
  if (env.profile.accountChangedAt) {
    const elapsedMs = Date.now() - new Date(env.profile.accountChangedAt).getTime();
    if (elapsedMs >= 0 && elapsedMs < 5 * 60_000) {
      const mins = Math.max(1, Math.round(elapsedMs / 60_000));
      const warn = `NOTE: active account was changed ${mins} min ago — re-verify with the user before any write.`;
      process.stderr.write(isTty ? `${ANSI.yellow}${warn}${ANSI.reset}\n` : `${warn}\n`);
    }
  }
}

export function note(msg: string, ctx: GlobalFlags): void {
  if (ctx.quiet) return;
  process.stderr.write(`${msg}\n`);
}
