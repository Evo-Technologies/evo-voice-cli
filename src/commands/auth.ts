import fs from "node:fs";
import readline from "node:readline";
import { Command } from "commander";

import {
  ENV_DEFAULTS,
  credentialsPath,
  loadConfig,
  redactCookies,
  resolveActiveEnv,
  saveConfig,
  setEnvProfile,
  type EnvName,
  type ConfigFile,
} from "../config.js";
import { CliError, EXIT } from "../exit-codes.js";
import { addGlobalFlags } from "../global-flags.js";
import { getAuthStatus, postCredentials } from "../http.js";
import { emit, type GlobalFlags } from "../output.js";
import { tenantGuardStatus } from "../tenant-guard.js";

interface LoginOpts {
  user?: string;
  password?: string;
  env?: string;
  accountId?: string;
  accountName?: string;
}

export function buildAuthCommand(): Command {
  const cmd = new Command("auth").description("Manage Evo Voice credentials (cookie-based)");

  addGlobalFlags(cmd.command("login"))
    .description("Sign in to an env (prod|staging), pick an account, persist cookies")
    .option("--user <email>", "Email address / username")
    .option("--password <pw>", "Password (use - to read from stdin)")
    .action(async (opts: LoginOpts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags & LoginOpts>();
      const envName = (globals.env as EnvName | undefined) ?? loadConfig().activeEnv;
      assertEnvName(envName);

      const cfg = loadConfig();
      const baseUrl = ENV_DEFAULTS[envName].baseUrl;
      const user = await resolveUser(opts.user, !!globals.noInput);
      const password = await resolvePassword(opts.password, !!globals.noInput);

      const cookies = await postCredentials(baseUrl, user, password);
      if (!cookies["ss-id"] && !cookies["ss-pid"]) {
        throw new CliError(EXIT.AUTH, "Login did not return ss-id/ss-pid cookies. Check credentials.");
      }

      const status = await getAuthStatus(baseUrl, cookies);
      if (!status.isAuthenticated) {
        throw new CliError(EXIT.AUTH, "Login appeared to succeed but /auth/status reports unauthenticated.");
      }
      const accountIds = status.accountIds ?? [];
      const accountNames = status.accountNames ?? [];

      const picked = pickAccount(accountIds, accountNames, globals.accountId, globals.accountName, !!globals.noInput);

      const now = new Date().toISOString();
      const newCfg: ConfigFile = setEnvProfile(cfg, envName, {
        baseUrl,
        user: status.emailAddress ?? user,
        cookies,
        accountId: picked?.id,
        accountName: picked?.name,
        accountChangedAt: now,
        tenantConfirmedAt: picked ? now : undefined,
        lastTenantActivityAt: picked ? now : undefined,
      });
      saveConfig(newCfg);

      emit({
        authenticated: true,
        env: envName,
        baseUrl,
        user: status.emailAddress ?? user,
        accountId: picked?.id ?? null,
        accountName: picked?.name ?? null,
        availableAccounts: accountIds.map((id, i) => ({ id, name: accountNames[i] })),
        path: credentialsPath(),
      }, globals);
    });

  addGlobalFlags(cmd.command("status"))
    .description("Show current env, account, and verify the session still works")
    .action(async (_opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);

      if (!env.profile.cookies) {
        emit({
          authenticated: false,
          env: env.name,
          baseUrl: env.profile.baseUrl,
          error: `No cookies stored for env "${env.name}". Run: evov auth login --env ${env.name}`,
        }, globals);
        process.exit(EXIT.AUTH);
      }

      let ok = true;
      let error: string | undefined;
      let status;
      try {
        status = await getAuthStatus(env.profile.baseUrl, env.profile.cookies);
        if (!status.isAuthenticated) {
          ok = false;
          error = "Session expired. Run `evov auth login`.";
        }
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : String(err);
      }
      emit({
        authenticated: ok,
        env: env.name,
        baseUrl: env.profile.baseUrl,
        user: env.profile.user,
        accountId: env.profile.accountId ?? null,
        accountName: env.profile.accountName ?? null,
        cookies: redactCookies(env.profile.cookies),
        ...(status?.accountIds ? { availableAccounts: status.accountIds.map((id, i) => ({ id, name: status?.accountNames?.[i] })) } : {}),
        ...(error ? { error } : {}),
      }, globals);
      if (!ok) process.exit(EXIT.AUTH);
    });

  addGlobalFlags(cmd.command("whoami"))
    .description("Print the active env + account + user (no API call). Run this often.")
    .action((_opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const guard = tenantGuardStatus(cfg, env.name, env.profile);
      emit({
        env: env.name,
        baseUrl: env.profile.baseUrl,
        user: env.profile.user ?? null,
        accountId: env.profile.accountId ?? null,
        accountName: env.profile.accountName ?? null,
        accountChangedAt: env.profile.accountChangedAt ?? null,
        authenticated: !!env.profile.cookies && Object.keys(env.profile.cookies).length > 0,
        tenantGuard: guard,
      }, globals);
    });

  addGlobalFlags(cmd.command("logout"))
    .description("Clear stored cookies for an env (default: active env)")
    .action((_opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const cfg = loadConfig();
      const envName = (globals.env as EnvName | undefined) ?? cfg.activeEnv;
      assertEnvName(envName);

      const prof = cfg.envs[envName];
      const newProf = { ...(prof ?? { baseUrl: ENV_DEFAULTS[envName].baseUrl }) };
      delete newProf.cookies;
      const newCfg = setEnvProfile(cfg, envName, newProf);
      saveConfig(newCfg);

      emit({ loggedOut: true, env: envName }, globals);
    });

  return cmd;
}

function assertEnvName(name: string): asserts name is EnvName {
  if (name !== "prod" && name !== "staging") {
    throw new CliError(EXIT.USAGE, `Unknown env "${name}". Valid: prod, staging.`);
  }
}

async function resolveUser(flag: string | undefined, noInput: boolean): Promise<string> {
  if (flag && flag.trim().length > 0) return flag.trim();
  if (process.env.EVO_VOICE_USER) return process.env.EVO_VOICE_USER;
  if (noInput) throw new CliError(EXIT.USAGE, "No --user provided and --no-input set");
  if (!process.stdin.isTTY) {
    throw new CliError(EXIT.USAGE, "No --user provided; stdin is not a TTY for prompting");
  }
  return promptLine("Email / username: ");
}

async function resolvePassword(flag: string | undefined, noInput: boolean): Promise<string> {
  if (flag === "-") {
    const buf = fs.readFileSync(0, "utf8").trim();
    if (buf.length === 0) throw new CliError(EXIT.USAGE, "Empty password on stdin");
    return buf;
  }
  if (flag && flag.length > 0) return flag;
  if (process.env.EVO_VOICE_PASSWORD) return process.env.EVO_VOICE_PASSWORD;
  if (noInput) throw new CliError(EXIT.USAGE, "No --password provided and --no-input set");
  if (!process.stdin.isTTY) {
    throw new CliError(EXIT.USAGE, "No --password provided; stdin is not a TTY for prompting");
  }
  return promptLineHidden("Password: ");
}

function promptLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); });
  });
}

function promptLineHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    const origRaw = stdin.isRaw ?? false;
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.removeListener("data", onData);
          if (typeof stdin.setRawMode === "function") stdin.setRawMode(origRaw);
          stdin.pause();
          process.stderr.write("\n");
          resolve(buf);
          return;
        } else if (c === "") {
          process.exit(EXIT.USAGE);
        } else if (c === "" || c === "\b") {
          buf = buf.slice(0, -1);
        } else {
          buf += c;
        }
      }
    };
    stdin.on("data", onData);
  });
}

function pickAccount(
  ids: string[],
  names: string[],
  byId: string | undefined,
  byName: string | undefined,
  noInput: boolean,
): { id: string; name: string } | undefined {
  if (ids.length === 0) return undefined;
  if (byId) {
    const idx = ids.indexOf(byId);
    if (idx === -1) {
      throw new CliError(
        EXIT.USAGE,
        `Account id "${byId}" is not in this user's accessible accounts. Available:\n` +
          ids.map((id, i) => `  - ${id}  ${names[i] ?? ""}`).join("\n"),
      );
    }
    return { id: ids[idx], name: names[idx] };
  }
  if (byName) {
    const idx = names.findIndex((n) => n?.toLowerCase() === byName.toLowerCase());
    if (idx === -1) {
      throw new CliError(
        EXIT.USAGE,
        `Account name "${byName}" is not in this user's accessible accounts. Available:\n` +
          names.map((n, i) => `  - ${n}  (${ids[i]})`).join("\n"),
      );
    }
    return { id: ids[idx], name: names[idx] };
  }
  if (ids.length === 1) return { id: ids[0], name: names[0] };
  if (noInput) {
    throw new CliError(
      EXIT.USAGE,
      `Multiple accounts available; pass --account-name or --account-id. Available:\n` +
        names.map((n, i) => `  - ${n}  (${ids[i]})`).join("\n"),
    );
  }
  throw new CliError(
    EXIT.USAGE,
    `Multiple accounts available. Re-run with --account-name "<name>" (or --account-id):\n` +
      names.map((n, i) => `  - ${n}  (${ids[i]})`).join("\n"),
  );
}
