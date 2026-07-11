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
  withDefaultAccount,
  type PaginationOptions,
} from "./common.js";

interface CustomerListOptions extends PaginationOptions {
  name?: string;
  parentCustomerId?: string[];
  shallowParent?: boolean;
  tagId?: string[];
}

export function buildCustomerCommand(): Command {
  const root = new Command("customer").description("Manage customers and their schedules");

  const list = addGlobalFlags(root.command("list"))
    .description("List customers for the active account (GET /customers)")
    .option("--name <text>", "Filter by name")
    .option("--parent-customer-id <id>", "Filter by parent customer (repeatable)", collect, [] as string[])
    .option("--shallow-parent", "Only include direct children of the selected parent")
    .option("--tag-id <id>", "Require tag id (repeatable)", collect, [] as string[]);
  addPaginationOptions(list).action(async (options: CustomerListOptions, command: Command) => {
    const context = resolveCommandContext(command);
    await executeRead(context, "/customers", {
      ...paginationQuery(options),
      accountIds: [requireAccountId(context)],
      nameFilter: options.name,
      parentCustomerIds: optionalList(options.parentCustomerId),
      shallowParent: options.shallowParent,
      tagIds: optionalList(options.tagId),
    }, { emptyExit: true });
  });

  addGlobalFlags(root.command("get"))
    .argument("<id>", "Customer id")
    .description("Fetch one customer (GET /customers/{id})")
    .action(async (id: string, _options, command: Command) => {
      await executeRead(resolveCommandContext(command), `/customers/${encoded(id)}`);
    });

  addGlobalFlags(root.command("create").alias("new"))
    .description("Create a customer (POST /customers). Body via -f <file|->; active account is the default accountId.")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (options: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const body = withDefaultAccount(readObjectBody(options.file), context);
      await executeJsonWrite(context, {
        method: "POST",
        path: "/customers",
        body,
        summary: `Create customer on ${context.accountName} (${context.env.name}); fields: ${changedKeys(body)}`,
      });
    });

  addGlobalFlags(root.command("patch"))
    .argument("<id>", "Customer id")
    .description("Update a customer (PATCH /customers/{id}). Body via -f <file|->.")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (id: string, options: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const body = readObjectBody(options.file);
      await executeJsonWrite(context, {
        method: "PATCH",
        path: `/customers/${encoded(id)}`,
        body,
        summary: `Patch customer ${id} on ${context.accountName} (${context.env.name}); fields: ${changedKeys(body)}`,
      });
    });

  addGlobalFlags(root.command("delete"))
    .argument("<id>", "Customer id")
    .description("Delete a customer (DELETE /customers/{id}); staging requires --force")
    .action(async (id: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "DELETE",
        path: `/customers/${encoded(id)}`,
        summary: `delete customer ${id} from ${context.accountName}`,
      }, { destructive: true });
    });

  addGlobalFlags(root.command("inherited-schedule"))
    .argument("<id>", "Customer id")
    .description("Get the customer's inherited schedule")
    .action(async (id: string, _options, command: Command) => {
      await executeRead(resolveCommandContext(command), `/customers/${encoded(id)}/inherited-schedule`);
    });

  addGlobalFlags(root.command("set-staging"))
    .argument("<id>", "Customer id")
    .description("Set customer staging mode. Body: {\"isStaging\":true|false}.")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (id: string, options: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const body = readObjectBody(options.file);
      await executeJsonWrite(context, {
        method: "POST",
        path: `/customers/${encoded(id)}/staging`,
        body,
        summary: `Set staging mode for customer ${id} on ${context.accountName}; fields: ${changedKeys(body)}`,
      });
    });

  addGlobalFlags(root.command("test-schedule"))
    .argument("<id>", "Customer id")
    .description("Evaluate a schedule for a customer. Body via -f <file|->.")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (id: string, options: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const body = readObjectBody(options.file);
      await executeJsonWrite(context, {
        method: "POST",
        path: `/customers/${encoded(id)}/test-schedule`,
        body,
        summary: `Test schedule for customer ${id} on ${context.accountName}; fields: ${changedKeys(body)}`,
      });
    });

  return root;
}
