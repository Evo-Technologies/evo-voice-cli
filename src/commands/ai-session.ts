import { Command } from "commander";

import { CliError, EXIT } from "../exit-codes.js";
import { addGlobalFlags } from "../global-flags.js";
import {
  addPaginationOptions,
  changedKeys,
  encoded,
  executeJsonWrite,
  executeRead,
  paginationQuery,
  readObjectBody,
  requireAccountId,
  resolveCommandContext,
  type PaginationOptions,
} from "./common.js";

export function buildAiSessionCommand(): Command {
  const root = new Command("ai-session").description("Manage system-administrator AI/MCP sessions");

  const list = addGlobalFlags(root.command("list"))
    .description("List AI sessions for the active account (GET /ai/sessions)");
  addPaginationOptions(list).action(async (options: PaginationOptions, command: Command) => {
    const context = resolveCommandContext(command);
    await executeRead(context, "/ai/sessions", {
      ...paginationQuery(options),
      accountIds: [requireAccountId(context)],
    }, { emptyExit: true });
  });

  addGlobalFlags(root.command("get"))
    .argument("<id>", "AI session id")
    .description("Fetch one AI session")
    .action(async (id: string, _options, command: Command) => {
      await executeRead(resolveCommandContext(command), `/ai/sessions/${encoded(id)}`);
    });

  addGlobalFlags(root.command("create").alias("new"))
    .description("Create an AI session")
    .option("--purpose <text>", "Session purpose")
    .option("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (options: { purpose?: string; file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const input = options.file ? readObjectBody(options.file) : {};
      const body = {
        ...input,
        accountId: input.accountId ?? requireAccountId(context),
        purpose: options.purpose ?? input.purpose,
      };
      await executeJsonWrite(context, {
        method: "POST",
        path: "/ai/sessions",
        body,
        summary: `Create AI session on ${context.accountName}; fields: ${changedKeys(body)}`,
      });
    });

  addGlobalFlags(root.command("patch"))
    .argument("<id>", "AI session id")
    .description("Update an AI session purpose")
    .option("--purpose <text>", "New purpose")
    .option("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (id: string, options: { purpose?: string; file?: string }, command: Command) => {
      if (!options.file && options.purpose === undefined) {
        throw new CliError(EXIT.USAGE, "Provide --purpose or --file");
      }
      const context = resolveCommandContext(command);
      const input = options.file ? readObjectBody(options.file) : {};
      const body = options.purpose === undefined ? input : { ...input, purpose: options.purpose };
      await executeJsonWrite(context, {
        method: "PATCH",
        path: `/ai/sessions/${encoded(id)}`,
        body,
        summary: `Patch AI session ${id} on ${context.accountName}; fields: ${changedKeys(body)}`,
      });
    });

  addGlobalFlags(root.command("apply"))
    .argument("<id>", "AI session id")
    .description("Apply all actions in an AI session")
    .action(async (id: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "POST",
        path: `/ai/sessions/${encoded(id)}/apply`,
        summary: `Apply AI session ${id} on ${context.accountName}`,
      });
    });

  addGlobalFlags(root.command("clear-actions"))
    .argument("<id>", "AI session id")
    .description("Delete every queued action in an AI session; staging requires --force")
    .action(async (id: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "DELETE",
        path: `/ai/sessions/${encoded(id)}/actions`,
        summary: `clear all actions from AI session ${id} on ${context.accountName}`,
      }, { destructive: true });
    });

  addGlobalFlags(root.command("delete-action"))
    .argument("<id>", "AI session id")
    .argument("<actionId>", "Action id")
    .description("Delete one queued action; staging requires --force")
    .action(async (id: string, actionId: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "DELETE",
        path: `/ai/sessions/${encoded(id)}/actions/${encoded(actionId)}`,
        summary: `delete action ${actionId} from AI session ${id} on ${context.accountName}`,
      }, { destructive: true });
    });

  addGlobalFlags(root.command("delete"))
    .argument("<id>", "AI session id")
    .description("Delete an AI session; staging requires --force")
    .action(async (id: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "DELETE",
        path: `/ai/sessions/${encoded(id)}`,
        summary: `delete AI session ${id} from ${context.accountName}`,
      }, { destructive: true });
    });

  addGlobalFlags(root.command("usage"))
    .description("Get AI usage for an account/customer/date range")
    .option("--customer-id <id>", "Customer id")
    .requiredOption("--start-date <yyyy-mm-dd>", "Start date (required by the API)")
    .requiredOption("--end-date <yyyy-mm-dd>", "End date (required by the API)")
    .action(async (options: { customerId?: string; startDate?: string; endDate?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      await executeRead(context, "/ai/usage", {
        accountId: requireAccountId(context),
        customerId: options.customerId,
        startDate: options.startDate,
        endDate: options.endDate,
      });
    });

  return root;
}
