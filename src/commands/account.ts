import { Command } from "commander";

import {
  loadConfig,
  requireAuthenticated,
  resolveActiveEnv,
  saveConfig,
  setEnvProfile,
  type EnvName,
} from "../config.js";
import { CliError, EXIT } from "../exit-codes.js";
import { addGlobalFlags } from "../global-flags.js";
import { getAuthStatus, ssFetch } from "../http.js";
import { emit, printBanner, type GlobalFlags } from "../output.js";
import {
  configureTenantGuard,
  confirmTenantContext,
  tenantGuardStatus,
} from "../tenant-guard.js";
import {
  addPaginationOptions,
  changedKeys,
  encoded,
  executeJsonWrite,
  executeRead,
  paginationQuery,
  readObjectBody,
  resolveCommandContext,
  type PaginationOptions,
} from "./common.js";

interface AccountInfo {
  id: string;
  name: string;
  parentAccountId?: string;
  isBYOA?: boolean;
}

export function buildAccountCommand(): Command {
  const cmd = new Command("account").description("List accessible accounts, get details, or set the active account");

  addGlobalFlags(cmd.command("list"))
    .description("List accounts the current user can access in the active env")
    .action(async (_opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const prof = requireAuthenticated(env);
      printBanner(env, globals, prof.user);

      // Source of truth: /auth/status returns the user's authorised account list.
      const status = await getAuthStatus(env.profile.baseUrl, prof.cookies);
      const ids = status.accountIds ?? [];
      const names = status.accountNames ?? [];
      const rows = ids.map((id, i) => ({
        id,
        name: names[i] ?? "(unnamed)",
        active: id === env.profile.accountId,
      }));
      emit(rows, { ...globals, emptyExit: true });
    });

  addGlobalFlags(cmd.command("get"))
    .argument("[id]", "Account id (defaults to active account)")
    .description("Fetch the full /accounts/{id} record")
    .action(async (id: string | undefined, _opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const prof = requireAuthenticated(env);
      printBanner(env, globals, prof.user);

      const accountId = id ?? env.profile.accountId;
      if (!accountId) {
        throw new CliError(EXIT.USAGE, "No account id given and no active account set. Run `evov account use <name>` first.");
      }
      const res = await ssFetch<AccountInfo>("GET", `/accounts/${encodeURIComponent(accountId)}`, {
        baseUrl: env.profile.baseUrl,
        cookies: prof.cookies,
      });
      emit(res.data, globals);
    });

  addGlobalFlags(cmd.command("use"))
    .argument("<nameOrId>", "Account name or id")
    .description("Set the active account inside the current env (no API write)")
    .action(async (nameOrId: string, _opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const prof = requireAuthenticated(env);

      // Fetch the user's account list to validate.
      const status = await getAuthStatus(env.profile.baseUrl, prof.cookies);
      const ids = status.accountIds ?? [];
      const names = status.accountNames ?? [];

      let idx = ids.indexOf(nameOrId);
      if (idx === -1) idx = names.findIndex((n) => n?.toLowerCase() === nameOrId.toLowerCase());
      if (idx === -1) {
        throw new CliError(
          EXIT.USAGE,
          `"${nameOrId}" is not in this user's accessible accounts. Available:\n` +
            ids.map((id, i) => `  - ${names[i]}  (${id})`).join("\n"),
        );
      }

      const newProf = {
        ...env.profile,
        accountId: ids[idx],
        accountName: names[idx],
        accountChangedAt: new Date().toISOString(),
        tenantConfirmedAt: undefined,
        lastTenantActivityAt: undefined,
      };
      const newCfg = setEnvProfile(cfg, env.name, newProf);
      saveConfig(newCfg);

      emit({
        env: env.name,
        accountId: newProf.accountId,
        accountName: newProf.accountName,
        accountChangedAt: newProf.accountChangedAt,
        requiresTenantConfirmation: true,
      }, globals);
    });

  addGlobalFlags(cmd.command("confirm"))
    .argument("<nameOrId>", "Exact active tenant name or id")
    .description("Explicitly confirm the active tenant after login, switching, or idle expiry")
    .action(async (nameOrId: string, _opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const status = confirmTenantContext(globals.env as EnvName | undefined, nameOrId);
      emit({ confirmed: true, tenantGuard: status }, globals);
    });

  addGlobalFlags(cmd.command("guard"))
    .argument("[minutes]", "Idle minutes (1..1440), off/0 to disable; omit to show")
    .description("Show or configure the tenant idle-confirmation guard")
    .action(async (minutes: string | undefined, _opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      if (minutes !== undefined) {
        const normalized = minutes.trim().toLowerCase();
        if (["off", "0", "disabled"].includes(normalized)) configureTenantGuard(null);
        else configureTenantGuard(Number(minutes));
      }
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      emit({
        configuredIdleMinutes: cfg.tenantGuardIdleMinutes === undefined ? 15 : cfg.tenantGuardIdleMinutes,
        tenantGuard: tenantGuardStatus(cfg, env.name, env.profile),
      }, globals);
    });

  const search = addGlobalFlags(cmd.command("search"))
    .description("Search full account records (GET /accounts; normally SystemAdministrator only)")
    .option("--name <text>", "Filter by account name");
  addPaginationOptions(search).action(async (opts: PaginationOptions & { name?: string }, command: Command) => {
    await executeRead(resolveCommandContext(command), "/accounts", {
      ...paginationQuery(opts),
      nameFilter: opts.name,
    }, { emptyExit: true });
  });

  addGlobalFlags(cmd.command("create").alias("new"))
    .description("Create an account (POST /accounts; SystemAdministrator only)")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (opts: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const body = readObjectBody(opts.file);
      await executeJsonWrite(context, {
        method: "POST",
        path: "/accounts",
        body,
        summary: `Create account; fields: ${changedKeys(body)}`,
      });
    });

  addGlobalFlags(cmd.command("patch"))
    .argument("<id>", "Account id")
    .description("Patch an account (SystemAdministrator only)")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (id: string, opts: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const body = readObjectBody(opts.file);
      await executeJsonWrite(context, {
        method: "PATCH",
        path: `/accounts/${encoded(id)}`,
        body,
        summary: `Patch account ${id}; fields: ${changedKeys(body)}`,
      });
    });

  addGlobalFlags(cmd.command("check"))
    .argument("<id>", "Account id")
    .description("Run server-side account checks")
    .action(async (id: string, _opts, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "POST",
        path: `/accounts/${encoded(id)}/check`,
        summary: `Run checks for account ${id}`,
      });
    });

  addGlobalFlags(cmd.command("regenerate-tokens"))
    .argument("<id>", "Account id")
    .description("Regenerate account tokens")
    .action(async (id: string, _opts, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "POST",
        path: `/accounts/${encoded(id)}/tokens`,
        summary: `Regenerate tokens for account ${id}`,
      });
    });

  addGlobalFlags(cmd.command("delete"))
    .argument("<id>", "Account id")
    .description("Delete an account; staging requires --force")
    .action(async (id: string, _opts, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "DELETE",
        path: `/accounts/${encoded(id)}`,
        summary: `delete account ${id}`,
      }, { destructive: true });
    });

  return cmd;
}
