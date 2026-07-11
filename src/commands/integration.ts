import { Command, Option } from "commander";

import { CliError, EXIT } from "../exit-codes.js";
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

const INTEGRATION_TYPES = ["HostedSuite", "OfficeRnd", "Zoho"];

interface IntegrationListOptions extends PaginationOptions {
  name?: string;
  customerId?: string[];
  shallowParent?: boolean;
}

export function buildIntegrationCommand(): Command {
  const root = new Command("integration").description("Manage CRM and third-party integrations");

  const list = addGlobalFlags(root.command("list"))
    .description("List integrations for the active account")
    .option("--name <text>", "Filter by name")
    .option("--customer-id <id>", "Filter by customer id (repeatable)", collect, [] as string[])
    .option("--shallow-parent", "Only match direct customer scope");
  addPaginationOptions(list).action(async (options: IntegrationListOptions, command: Command) => {
    const context = resolveCommandContext(command);
    await executeRead(context, "/integrations", {
      ...paginationQuery(options),
      accountIds: [requireAccountId(context)],
      nameFilter: options.name,
      customerIds: optionalList(options.customerId),
      shallowParent: options.shallowParent,
    }, { emptyExit: true });
  });

  addGlobalFlags(root.command("get"))
    .argument("<id>", "Integration id")
    .description("Fetch one integration")
    .action(async (id: string, _options, command: Command) => {
      await executeRead(resolveCommandContext(command), `/integrations/${encoded(id)}`);
    });

  addGlobalFlags(root.command("create").alias("new"))
    .description("Create an integration; body via -f or typed flags")
    .option("-f, --file <path>", "JSON body file (use - for stdin)")
    .addOption(new Option("--type <type>", "Integration type").choices(INTEGRATION_TYPES))
    .option("--name <name>", "Integration name")
    .option("--customer-id <id>", "Optional customer scope")
    .action(async (options: { file?: string; type?: string; name?: string; customerId?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const input = options.file ? readObjectBody(options.file) : {};
      const body: Record<string, unknown> = {
        ...input,
        accountId: input.accountId ?? requireAccountId(context),
      };
      if (options.type !== undefined) body.type = options.type;
      if (options.name !== undefined) body.name = options.name;
      if (options.customerId !== undefined) body.customerId = options.customerId;
      if (!body.type || !body.name) throw new CliError(EXIT.USAGE, "Integration create requires type and name (flags or body fields)");
      await executeJsonWrite(context, {
        method: "POST",
        path: "/integrations",
        body,
        summary: `Create ${String(body.type)} integration ${String(body.name)} on ${context.accountName}`,
      });
    });

  addGlobalFlags(root.command("patch"))
    .argument("<id>", "Integration id")
    .description("Patch an integration")
    .requiredOption("-f, --file <path>", "JSON body file (use - for stdin)")
    .action(async (id: string, options: { file?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const body = readObjectBody(options.file);
      await executeJsonWrite(context, {
        method: "PATCH",
        path: `/integrations/${encoded(id)}`,
        body,
        summary: `Patch integration ${id} on ${context.accountName}; fields: ${changedKeys(body)}`,
      });
    });

  addGlobalFlags(root.command("delete"))
    .argument("<id>", "Integration id")
    .description("Delete an integration; staging requires --force")
    .action(async (id: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "DELETE",
        path: `/integrations/${encoded(id)}`,
        summary: `delete integration ${id} from ${context.accountName}`,
      }, { destructive: true });
    });

  addGlobalFlags(root.command("log"))
    .argument("<id>", "Integration id")
    .description("Get the integration sync log")
    .action(async (id: string, _options, command: Command) => {
      await executeRead(resolveCommandContext(command), `/integrations/${encoded(id)}/log`);
    });

  addGlobalFlags(root.command("contacts"))
    .argument("<id>", "Integration id")
    .description("Search CRM contacts")
    .option("--customer-id <id>", "Evo Voice customer id")
    .option("--query <text>", "CRM search text")
    .action(async (id: string, options: { customerId?: string; query?: string }, command: Command) => {
      await executeRead(resolveCommandContext(command), `/integrations/${encoded(id)}/contacts`, {
        customerId: options.customerId,
        query: options.query,
      }, { emptyExit: true });
    });

  addGlobalFlags(root.command("customers"))
    .argument("<id>", "Integration id")
    .description("Search CRM customers")
    .option("--query <text>", "CRM search text")
    .action(async (id: string, options: { query?: string }, command: Command) => {
      await executeRead(resolveCommandContext(command), `/integrations/${encoded(id)}/customers`, {
        query: options.query,
      }, { emptyExit: true });
    });

  addGlobalFlags(root.command("map-customer"))
    .argument("<id>", "Integration id")
    .argument("<customerId>", "Evo Voice customer id")
    .requiredOption("--maps-to-id <id>", "CRM customer id")
    .description("Map an Evo Voice customer to a CRM customer")
    .action(async (id: string, customerId: string, options: { mapsToId?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "POST",
        path: `/integrations/${encoded(id)}/customers/${encoded(customerId)}/map`,
        body: { mapsToId: options.mapsToId },
        summary: `Map customer ${customerId} through integration ${id} on ${context.accountName}`,
      });
    });

  addGlobalFlags(root.command("map-user"))
    .argument("<id>", "Integration id")
    .argument("<userId>", "Evo Voice user endpoint id")
    .requiredOption("--maps-to-id <id>", "CRM contact id")
    .description("Map an Evo Voice user to a CRM contact")
    .action(async (id: string, userId: string, options: { mapsToId?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "POST",
        path: `/integrations/${encoded(id)}/users/${encoded(userId)}/map`,
        body: { mapsToId: options.mapsToId },
        summary: `Map user ${userId} through integration ${id} on ${context.accountName}`,
      });
    });

  addGlobalFlags(root.command("sync"))
    .argument("<id>", "Integration id")
    .description("Run an integration sync")
    .action(async (id: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "POST",
        path: `/integrations/${encoded(id)}/sync`,
        summary: `Sync integration ${id} on ${context.accountName}`,
      });
    });

  return root;
}
