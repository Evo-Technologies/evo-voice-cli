import { Command } from "commander";

import {
  loadConfig,
  requireAuthenticated,
  resolveActiveEnv,
  saveConfig,
  type ConfigFile,
  type EnvName,
  type EnvProfile,
} from "./config.js";
import { CliError, EXIT } from "./exit-codes.js";
import { emit, type GlobalFlags } from "./output.js";

export const DEFAULT_TENANT_IDLE_MINUTES = 15;

export interface TenantGuardStatus {
  enabled: boolean;
  idleMinutes: number | null;
  env: EnvName;
  accountId?: string;
  accountName?: string;
  tenantConfirmedAt?: string;
  lastTenantActivityAt?: string;
  idleForMinutes?: number;
  confirmationRequired: boolean;
  reason?: "never-confirmed" | "idle" | "account-override" | "pending-account-mismatch";
}

export function effectiveTenantIdleMinutes(cfg: ConfigFile): number | null {
  const override = process.env.EVO_VOICE_TENANT_IDLE_MINUTES;
  if (override !== undefined && override.trim() !== "") {
    if (["off", "disabled", "0"].includes(override.trim().toLowerCase())) return null;
    const value = Number(override);
    if (!Number.isInteger(value) || value < 1 || value > 1440) {
      throw new CliError(EXIT.CONFIG, "EVO_VOICE_TENANT_IDLE_MINUTES must be 1..1440, 0, or off.");
    }
    return value;
  }
  return cfg.tenantGuardIdleMinutes === undefined ? DEFAULT_TENANT_IDLE_MINUTES : cfg.tenantGuardIdleMinutes;
}

export function tenantGuardStatus(
  cfg: ConfigFile,
  envName: EnvName,
  profile: EnvProfile,
  now = Date.now(),
): TenantGuardStatus {
  const idleMinutes = effectiveTenantIdleMinutes(cfg);
  const base = {
    enabled: idleMinutes !== null,
    idleMinutes,
    env: envName,
    accountId: profile.accountId,
    accountName: profile.accountName,
    tenantConfirmedAt: profile.tenantConfirmedAt,
    lastTenantActivityAt: profile.lastTenantActivityAt,
  };
  if (idleMinutes === null || !profile.accountId) return { ...base, confirmationRequired: false };
  if (!profile.tenantConfirmedAt || !profile.lastTenantActivityAt) {
    return { ...base, confirmationRequired: true, reason: "never-confirmed" };
  }
  const activityTime = new Date(profile.lastTenantActivityAt).getTime();
  const idleForMinutes = Number.isFinite(activityTime) ? Math.max(0, (now - activityTime) / 60_000) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(activityTime) || idleForMinutes >= idleMinutes) {
    return { ...base, idleForMinutes, confirmationRequired: true, reason: "idle" };
  }
  return { ...base, idleForMinutes, confirmationRequired: false };
}

export function configureTenantGuard(value: number | null): { idleMinutes: number | null; enabled: boolean } {
  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 1440)) {
    throw new CliError(EXIT.USAGE, "Tenant idle timeout must be an integer from 1 to 1440 minutes, or off.");
  }
  const cfg = loadConfig();
  cfg.tenantGuardIdleMinutes = value;
  saveConfig(cfg);
  return { idleMinutes: value, enabled: value !== null };
}

export function confirmTenantContext(
  envOverride: EnvName | undefined,
  nameOrId: string,
): TenantGuardStatus {
  const cfg = loadConfig();
  const env = resolveActiveEnv(cfg, envOverride);
  const profile = requireAuthenticated(env);
  if (!profile.accountId || !profile.accountName) {
    throw new CliError(EXIT.USAGE, "No active tenant is selected. Run `evov account list` and `evov account use <nameOrId>` first.");
  }
  const matches = nameOrId === profile.accountId || nameOrId.trim().toLowerCase() === profile.accountName.trim().toLowerCase();
  if (!matches) {
    throw new CliError(
      EXIT.USAGE,
      `"${nameOrId}" does not match the active tenant ${profile.accountName} (${profile.accountId}). ` +
      "Run `evov account use <nameOrId>` first if you intend to switch.",
    );
  }
  const now = new Date().toISOString();
  env.profile = { ...profile, tenantConfirmedAt: now, lastTenantActivityAt: now };
  cfg.envs[env.name] = env.profile;
  saveConfig(cfg);
  return tenantGuardStatus(cfg, env.name, env.profile);
}

export function enforceTenantGuard(command: Command): void {
  if (isTenantGuardExempt(command)) return;
  const globals = command.optsWithGlobals<GlobalFlags>();
  const cfg = loadConfig();
  const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
  const profile = requireAuthenticated(env);
  if (globals.accountId && globals.accountId !== profile.accountId && effectiveTenantIdleMinutes(cfg) !== null) {
    requireTenantConfirmation({
      enabled: true,
      idleMinutes: effectiveTenantIdleMinutes(cfg),
      env: env.name,
      accountId: globals.accountId,
      accountName: undefined,
      confirmationRequired: true,
      reason: "account-override",
    }, globals, "A one-call --account-id override cannot use another tenant while the guard is enabled. Switch and reconfirm it first.");
  }
  const status = tenantGuardStatus(cfg, env.name, profile);
  if (status.confirmationRequired) requireTenantConfirmation(status, globals);
  touchTenantActivity(cfg, env.name, profile);
}

export function enforcePendingTenantGuard(
  envName: EnvName,
  expectedAccountId: string | undefined,
  globals: GlobalFlags,
): void {
  const cfg = loadConfig();
  const env = resolveActiveEnv(cfg, envName);
  const profile = requireAuthenticated(env);
  if (expectedAccountId && profile.accountId !== expectedAccountId && effectiveTenantIdleMinutes(cfg) !== null) {
    requireTenantConfirmation({
      ...tenantGuardStatus(cfg, env.name, profile),
      accountId: expectedAccountId,
      accountName: undefined,
      confirmationRequired: true,
      reason: "pending-account-mismatch",
    }, globals, "The pending write belongs to a different tenant. Switch to that tenant and reconfirm before executing it.");
  }
  const status = tenantGuardStatus(cfg, env.name, profile);
  if (status.confirmationRequired) requireTenantConfirmation(status, globals);
  touchTenantActivity(cfg, env.name, profile);
}

export function isTenantGuardExempt(command: Command): boolean {
  const names = commandPath(command);
  const root = names[0];
  const sub = names[1];
  if (["auth", "env", "whoami", "schema", "exit-codes"].includes(root)) return true;
  if (root === "confirm") return true; // Checked against the pending action's own env/account in confirm.ts.
  if (root === "account" && ["list", "use", "confirm", "guard"].includes(sub)) return true;
  if (root === "flow" && ["logic", "validate"].includes(sub) && !!command.opts().file) return true;
  if (root === "flow" && sub === "diff" && !!command.opts().leftFile && !!command.opts().rightFile) return true;
  if (root === "flow" && sub === "blueprint" && ["list", "add", "show", "remove"].includes(names[2])) return true;
  return false;
}

function commandPath(command: Command): string[] {
  const values: string[] = [];
  let current: Command | null = command;
  while (current?.parent) {
    values.unshift(current.name());
    current = current.parent;
  }
  return values;
}

function touchTenantActivity(cfg: ConfigFile, envName: EnvName, profile: EnvProfile): void {
  const now = new Date().toISOString();
  cfg.envs[envName] = { ...profile, lastTenantActivityAt: now };
  saveConfig(cfg);
}

function requireTenantConfirmation(status: TenantGuardStatus, globals: GlobalFlags, detail?: string): never {
  const idle = status.idleForMinutes === undefined || !Number.isFinite(status.idleForMinutes)
    ? undefined
    : Math.floor(status.idleForMinutes);
  const account = status.accountName
    ? { id: status.accountId, name: status.accountName }
    : status.accountId ? { id: status.accountId } : null;
  emit({
    requiresTenantConfirmation: true,
    env: status.env,
    account,
    idleMinutes: status.idleMinutes,
    idleForMinutes: idle,
    lastTenantActivityAt: status.lastTenantActivityAt,
    reason: status.reason,
    instruction: "Ask the user which tenant they intend, wait for their reply, then run `evov account confirm <exact-name-or-id>`.",
  }, { ...globals, out: undefined, plain: false });
  if (!globals.quiet) {
    process.stderr.write(
      `${detail ? `${detail}\n` : ""}` +
      `Tenant confirmation required for ${status.accountName ?? status.accountId ?? "the active tenant"}.\n` +
      "Ask the user to confirm the intended tenant, then run:\n" +
      `    evov account confirm "${status.accountName ?? status.accountId ?? "<nameOrId>"}"\n`,
    );
  }
  throw new CliError(EXIT.TENANT_CONFIRMATION_REQUIRED, "");
}
