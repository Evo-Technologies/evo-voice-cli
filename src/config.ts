import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CliError, EXIT } from "./exit-codes.js";

export type EnvName = "prod" | "staging";

export const ENV_DEFAULTS: Record<EnvName, { baseUrl: string }> = {
  prod: { baseUrl: "https://evovoice.io" },
  staging: { baseUrl: "https://team.evovoice.io" },
};

export interface EnvProfile {
  baseUrl: string;
  user?: string;
  cookies?: Record<string, string>;
  accountId?: string;
  accountName?: string;
  accountChangedAt?: string;
}

export interface ConfigFile {
  activeEnv: EnvName;
  envs: Partial<Record<EnvName, EnvProfile>>;
}

export interface ResolvedEnv {
  name: EnvName;
  profile: EnvProfile;
}

export function configDir(): string {
  if (process.env.EVO_VOICE_CONFIG_DIR) return process.env.EVO_VOICE_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "evo-voice");
}

export function cacheDir(): string {
  if (process.env.EVO_VOICE_CACHE_DIR) return process.env.EVO_VOICE_CACHE_DIR;
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "evo-voice");
}

export function credentialsPath(): string {
  return path.join(configDir(), "credentials.json");
}

export function pendingPath(): string {
  return path.join(cacheDir(), "pending.json");
}

function blankConfig(): ConfigFile {
  return {
    activeEnv: "staging",
    envs: {
      staging: { baseUrl: ENV_DEFAULTS.staging.baseUrl },
    },
  };
}

export function loadConfig(): ConfigFile {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return blankConfig();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<ConfigFile>;
    if (!parsed.activeEnv || !parsed.envs) return blankConfig();
    return parsed as ConfigFile;
  } catch (err) {
    throw new CliError(
      EXIT.CONFIG,
      `Failed to read ${file}: ${(err as Error).message}`,
    );
  }
}

export function saveConfig(cfg: ConfigFile): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsPath();
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
  return file;
}

export function resolveActiveEnv(cfg: ConfigFile, override?: EnvName): ResolvedEnv {
  const name = override ?? cfg.activeEnv;
  const profile = cfg.envs[name] ?? { baseUrl: ENV_DEFAULTS[name].baseUrl };
  return { name, profile };
}

export function requireAuthenticated(env: ResolvedEnv): Required<Pick<EnvProfile, "cookies">> & EnvProfile {
  if (!env.profile.cookies || Object.keys(env.profile.cookies).length === 0) {
    throw new CliError(
      EXIT.AUTH,
      `Not authenticated for env "${env.name}". Run: evov auth login --env ${env.name}`,
    );
  }
  return env.profile as Required<Pick<EnvProfile, "cookies">> & EnvProfile;
}

export function setEnvProfile(cfg: ConfigFile, name: EnvName, profile: EnvProfile): ConfigFile {
  return { ...cfg, envs: { ...cfg.envs, [name]: profile } };
}

export function redactCookies(cookies?: Record<string, string>): string {
  if (!cookies || Object.keys(cookies).length === 0) return "(none)";
  return Object.keys(cookies).map((k) => `${k}=…`).join("; ");
}

export function isProd(env: ResolvedEnv): boolean {
  return env.name === "prod";
}

// Pending action store (phase-1/phase-2 confirmation)

export interface PendingAction {
  token: string;
  env: EnvName;
  baseUrl: string;
  accountId?: string;
  accountName?: string;
  method: "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  query?: Record<string, string | number | string[]>;
  body?: unknown;
  action: string;          // e.g. "DELETE /sessions"
  summary: string;         // human-readable
  createdAt: string;
  expiresAt: string;
  consumed?: boolean;
}

interface PendingFile {
  actions: Record<string, PendingAction>;
}

function loadPending(): PendingFile {
  const file = pendingPath();
  if (!fs.existsSync(file)) return { actions: {} };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as PendingFile;
  } catch {
    return { actions: {} };
  }
}

function savePending(p: PendingFile): void {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = pendingPath();
  fs.writeFileSync(file, JSON.stringify(p, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
}

export function recordPending(action: PendingAction): void {
  const p = loadPending();
  gcPending(p);
  p.actions[action.token] = action;
  savePending(p);
}

export function getPending(token: string): PendingAction {
  const p = loadPending();
  const a = p.actions[token];
  if (!a) throw new CliError(EXIT.AUTH, `Unknown token "${token}". Re-run the original command to get a fresh token.`);
  if (a.consumed) throw new CliError(EXIT.AUTH, `Token "${token}" already consumed. Re-run the original command for a fresh token.`);
  if (new Date(a.expiresAt).getTime() < Date.now()) {
    throw new CliError(EXIT.AUTH, `Token "${token}" expired. Re-run the original command for a fresh token.`);
  }
  return a;
}

export function consumePending(token: string): void {
  const p = loadPending();
  if (p.actions[token]) {
    p.actions[token].consumed = true;
    savePending(p);
  }
}

function gcPending(p: PendingFile): void {
  const now = Date.now();
  for (const [tok, a] of Object.entries(p.actions)) {
    const exp = new Date(a.expiresAt).getTime();
    // Drop anything more than an hour past expiry to keep the file small
    if (exp + 3600_000 < now) delete p.actions[tok];
  }
}
