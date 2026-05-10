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
      };
      const newCfg = setEnvProfile(cfg, env.name, newProf);
      saveConfig(newCfg);

      emit({
        env: env.name,
        accountId: newProf.accountId,
        accountName: newProf.accountName,
        accountChangedAt: newProf.accountChangedAt,
      }, globals);
    });

  return cmd;
}
