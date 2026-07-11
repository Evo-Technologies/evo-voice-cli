import path from "node:path";
import { pathToFileURL } from "node:url";

import { Command } from "commander";

import { buildAccountCommand } from "./commands/account.js";
import { buildAiSessionCommand } from "./commands/ai-session.js";
import { buildApiCommand } from "./commands/api.js";
import { buildAuthCommand } from "./commands/auth.js";
import { buildConfirmCommand } from "./commands/confirm.js";
import { buildCustomerCommand } from "./commands/customer.js";
import { buildEndpointCommand } from "./commands/endpoint.js";
import { buildEnvCommand } from "./commands/env.js";
import { buildFileCommand } from "./commands/file.js";
import { buildFlowCommand } from "./commands/flow.js";
import { buildIntegrationCommand } from "./commands/integration.js";
import { buildReportCommand } from "./commands/report.js";
import { buildSessionCommand } from "./commands/session.js";
import { buildSysCommand } from "./commands/sys.js";
import { CliError, EXIT, EXIT_DESCRIPTIONS } from "./exit-codes.js";
import { addGlobalFlags, normalizeAliases } from "./global-flags.js";
import { emit, type GlobalFlags } from "./output.js";
import { findSubcommand, serializeCommand } from "./schema.js";
import { enforceTenantGuard, tenantGuardStatus } from "./tenant-guard.js";

const VERSION = "0.2.0";

function buildProgram(): Command {
  const program = new Command();

  program
    .name("evov")
    .description(
      "CLI for Evo Voice (evovoice.io). Reads run freely; production writes are two-phase (exit 11 → `evov confirm <token>`).",
    )
    .version(VERSION)
    .showHelpAfterError();

  program.hook("preAction", normalizeAliases);
  program.hook("preAction", (_thisCommand, actionCommand) => enforceTenantGuard(actionCommand));

  program.addCommand(buildAuthCommand());
  program.addCommand(buildEnvCommand());
  program.addCommand(buildAccountCommand());
  program.addCommand(buildSessionCommand());
  program.addCommand(buildEndpointCommand());
  program.addCommand(buildCustomerCommand());
  program.addCommand(buildFlowCommand());
  program.addCommand(buildFileCommand());
  program.addCommand(buildAiSessionCommand());
  program.addCommand(buildReportCommand());
  program.addCommand(buildIntegrationCommand());
  program.addCommand(buildSysCommand());
  program.addCommand(buildApiCommand());
  program.addCommand(buildConfirmCommand());

  // Top-level shortcut: `evov whoami` mirrors `evov auth whoami`.
  addGlobalFlags(program.command("whoami"))
    .description("Print active env + account + user (shortcut for `evov auth whoami`)")
    .action(async (_opts, command: Command) => {
      const { loadConfig, resolveActiveEnv } = await import("./config.js");
      const globals = command.optsWithGlobals<GlobalFlags>();
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as ("prod" | "staging" | undefined));
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

  addGlobalFlags(program.command("schema [path...]"))
    .description("Print the CLI command tree as JSON. Optional path narrows to a subcommand.")
    .action((parts: string[], _opts, command: Command) => {
      const globals = command.opts<GlobalFlags>();
      const target = parts.length === 0 ? program : findSubcommand(program, parts);
      if (!target) throw new CliError(EXIT.NOT_FOUND, `No such command: ${parts.join(" ")}`);
      emit(serializeCommand(target), globals);
    });

  addGlobalFlags(program.command("exit-codes"))
    .description("Print the CLI exit-code map as JSON.")
    .action((_opts, command: Command) => {
      const globals = command.opts<GlobalFlags>();
      const map: Record<string, { code: number; description: string }> = {};
      for (const [k, v] of Object.entries(EXIT)) {
        map[k] = { code: v, description: EXIT_DESCRIPTIONS[v] };
      }
      emit(map, globals);
    });

  return program;
}

export async function main(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}

export function handleError(err: unknown): never {
  if (err instanceof CliError) {
    if (err.message && err.message.length > 0) process.stderr.write(`${err.message}\n`);
    process.exit(err.code);
  }
  if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "commander.help") {
    process.exit(EXIT.OK);
  }
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("commander.")) {
      const msg = (err as { message?: unknown }).message;
      process.stderr.write(`${typeof msg === "string" ? msg : String(err)}\n`);
      process.exit(EXIT.USAGE);
    }
  }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(EXIT.ERR);
}

const invokedAsMain = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedAsMain) main(process.argv).catch(handleError);

export { buildProgram };
