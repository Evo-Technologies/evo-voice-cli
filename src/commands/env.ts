import { Command } from "commander";

import {
  ENV_DEFAULTS,
  loadConfig,
  resolveActiveEnv,
  saveConfig,
  type EnvName,
} from "../config.js";
import { CliError, EXIT } from "../exit-codes.js";
import { addGlobalFlags } from "../global-flags.js";
import { emit, type GlobalFlags } from "../output.js";

export function buildEnvCommand(): Command {
  const cmd = new Command("env").description("Switch between Evo Voice environments (prod, staging)");

  addGlobalFlags(cmd.command("list"))
    .description("List configured envs with auth + active account info")
    .action((_opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const cfg = loadConfig();
      const rows = (Object.keys(ENV_DEFAULTS) as EnvName[]).map((name) => {
        const prof = cfg.envs[name];
        const authenticated = !!prof?.cookies && Object.keys(prof.cookies).length > 0;
        return {
          name,
          baseUrl: ENV_DEFAULTS[name].baseUrl,
          active: cfg.activeEnv === name,
          authenticated,
          accountId: prof?.accountId ?? null,
          accountName: prof?.accountName ?? null,
          user: prof?.user ?? null,
        };
      });
      emit(rows, globals);
    });

  addGlobalFlags(cmd.command("use"))
    .argument("<name>", "Env name: prod or staging")
    .description("Set the persisted active env")
    .action((name: string, _opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      if (name !== "prod" && name !== "staging") {
        throw new CliError(EXIT.USAGE, `Unknown env "${name}". Valid: prod, staging.`);
      }
      const cfg = loadConfig();
      cfg.activeEnv = name;
      // Ensure the profile shell exists.
      if (!cfg.envs[name]) cfg.envs[name] = { baseUrl: ENV_DEFAULTS[name].baseUrl };
      saveConfig(cfg);
      const env = resolveActiveEnv(cfg);
      emit({
        env: env.name,
        baseUrl: env.profile.baseUrl,
        accountName: env.profile.accountName ?? null,
        accountId: env.profile.accountId ?? null,
        authenticated: !!env.profile.cookies && Object.keys(env.profile.cookies).length > 0,
      }, globals);
    });

  addGlobalFlags(cmd.command("current"))
    .description("Print the active env name")
    .action((_opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const cfg = loadConfig();
      emit({ env: cfg.activeEnv }, globals);
    });

  return cmd;
}
