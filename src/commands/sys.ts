import { Command } from "commander";

import { addGlobalFlags } from "../global-flags.js";
import {
  addPaginationOptions,
  changedKeys,
  collect,
  encoded,
  executeJsonWrite,
  executeRead,
  optionalList,
  paginationQuery,
  readObjectBody,
  requireAccountId,
  resolveCommandContext,
  type PaginationOptions,
} from "./common.js";

interface LogOptions extends PaginationOptions {
  customerId?: string[];
  startDate?: string;
  endDate?: string;
  description?: string;
}

export function buildSysCommand(): Command {
  const root = new Command("sys").description("System logs, global settings, account settings, and dialing permissions");

  const logs = addGlobalFlags(root.command("log-entries"))
    .description("List system log entries (ServiceStack ListLogEntries DTO route)")
    .option("--customer-id <id>", "Filter by customer id (repeatable; use _ for account-level logs)", collect, [] as string[])
    .option("--start-date <yyyy-mm-dd>", "Start date")
    .option("--end-date <yyyy-mm-dd>", "End date")
    .option("--description <text>", "Search description text");
  addPaginationOptions(logs).action(async (options: LogOptions, command: Command) => {
    const context = resolveCommandContext(command);
    await executeRead(context, "/json/reply/ListLogEntries", {
      ...paginationQuery(options),
      accountIds: [requireAccountId(context)],
      customerIds: optionalList(options.customerId),
      startDate: options.startDate,
      endDate: options.endDate,
      description: options.description,
    }, { emptyExit: true });
  });

  const globalSettings = root.command("global-settings").description("System-administrator global settings");
  addGlobalFlags(globalSettings.command("get"))
    .description("Get global settings (GET /global/settings)")
    .action(async (_options, command: Command) => {
      await executeRead(resolveCommandContext(command), "/global/settings");
    });
  addGlobalFlags(globalSettings.command("patch"))
    .description("Patch global settings (PATCH /global/settings)")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (options: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const body = readObjectBody(options.file);
      await executeJsonWrite(context, {
        method: "PATCH",
        path: "/global/settings",
        body,
        summary: `Patch global settings; fields: ${changedKeys(body)}`,
      });
    });

  const settings = root.command("settings").description("Per-account system settings and custom fields");
  addGlobalFlags(settings.command("get"))
    .description("Get system settings for the active account")
    .action(async (_options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeRead(context, "/system/settings", { accountId: requireAccountId(context) });
    });
  addGlobalFlags(settings.command("patch"))
    .description("Patch system settings. Uses the DTO route because the server REST route is misspelled PATCHY.")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (options: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const input = readObjectBody(options.file);
      const body = { ...input, accountId: input.accountId ?? requireAccountId(context) };
      await executeJsonWrite(context, {
        method: "PATCH",
        path: "/json/reply/PatchSystemSettings",
        body,
        summary: `Patch system settings on ${context.accountName}; fields: ${changedKeys(body)}`,
      });
    });

  const dialing = root.command("dialing-permissions").description("Twilio international dialing permissions");
  addGlobalFlags(dialing.command("list"))
    .description("List dialing permissions for the active account")
    .action(async (_options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeRead(context, "/system/dialing-permissions", { accountId: requireAccountId(context) });
    });
  addGlobalFlags(dialing.command("patch"))
    .argument("<isoCode>", "Country ISO code")
    .description("Patch one country's dialing permissions")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (isoCode: string, options: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const input = readObjectBody(options.file);
      const body = { ...input, accountId: input.accountId ?? requireAccountId(context) };
      await executeJsonWrite(context, {
        method: "PATCH",
        path: `/system/dialing-permissions/${encoded(isoCode)}`,
        body,
        summary: `Patch ${isoCode} dialing permissions on ${context.accountName}; fields: ${changedKeys(body)}`,
      });
    });

  return root;
}
