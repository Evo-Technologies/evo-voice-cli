import { Command, Option } from "commander";

import { CliError, EXIT } from "../exit-codes.js";
import { addGlobalFlags } from "../global-flags.js";
import { planRequest, ssDownload } from "../http.js";
import { emit, printBanner, writeBinaryOut } from "../output.js";
import {
  changedKeys,
  encoded,
  executeJsonWrite,
  executeRead,
  readObjectBody,
  requireAccountId,
  resolveCommandContext,
} from "./common.js";

const REPORT_ROUTES = {
  "agent-state": "/reports/agent-state",
  billing: "/reports/billing",
  "call-center-abandon": "/reports/call-center-abandon",
  "call-center-detail": "/reports/call-center-detail",
  "call-center": "/reports/call-center",
  "call-history": "/reports/call-history",
  "call-outcome": "/reports/call-outcome",
  cdr: "/reports/cdr",
  metric: "/reports/metric",
  // The REST attribute is GET-only while ReportsService implements Post.
  endpoints: "/json/reply/EndpointsReport",
  "sync-phone-numbers": "/reports/sync-phone-numbers",
} as const;

type ReportType = keyof typeof REPORT_ROUTES;

interface RunOptions {
  file?: string;
  startDate?: string;
  endDate?: string;
  timeZoneId?: string;
  customerId?: string;
  endpointId?: string;
  flowId?: string;
  metricName?: string;
  specificState?: string;
  includeArchivedSessions?: boolean;
  includeCustomerIds?: boolean;
  syncDocumoNumbers?: boolean;
  endpointType?: string[];
  email?: string;
  webhookUrl?: string;
}

interface ReportsResponse {
  reports?: Array<Record<string, unknown> & { id?: string }>;
}

export function buildReportCommand(): Command {
  const root = new Command("report").description("Generate, inspect, download, and delete asynchronous reports");

  addGlobalFlags(root.command("list"))
    .description("List reports created by the current user (GET /reports)")
    .action(async (_options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeRead(context, "/reports", { accountId: requireAccountId(context) }, { emptyExit: true });
    });

  addGlobalFlags(root.command("get"))
    .argument("<id>", "Report id")
    .description("Find one report in the current user's report list")
    .action(async (id: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeRead<ReportsResponse>(context, "/reports", { accountId: requireAccountId(context) }, {
        transform: (data) => {
          const report = data.reports?.find((item) => item.id === id);
          if (!report) throw new CliError(EXIT.NOT_FOUND, `No report ${id} found for the active account`);
          return report;
        },
      });
    });

  addGlobalFlags(root.command("run"))
    .argument("<type>", `Report type (${Object.keys(REPORT_ROUTES).join("|")})`)
    .description("Queue a report. Options cover common fields; -f can supply the complete request DTO.")
    .addOption(new Option("--report-type <type>", "Alias for the positional report type").hideHelp())
    .option("-f, --file <path>", "JSON body file (use - for stdin)")
    .option("--start-date <date>", "Report start date")
    .option("--end-date <date>", "Report end date")
    .option("--time-zone-id <id>", "Report time zone id")
    .option("--customer-id <id>", "Customer id")
    .option("--endpoint-id <id>", "Endpoint id")
    .option("--flow-id <id>", "Flow id")
    .option("--metric-name <name>", "Metric name (metric report)")
    .option("--specific-state <state>", "Specific outcome state")
    .option("--include-archived-sessions", "Include archived sessions")
    .option("--include-customer-ids", "Include customer ids in billing output")
    .option("--sync-documo-numbers", "Also sync Documo numbers")
    .option("--endpoint-type <type>", "Endpoint type for endpoints report (repeatable)", collectValues, [] as string[])
    .option("--email <address>", "Email address to notify")
    .option("--webhook-url <url>", "Completion webhook URL")
    .action(async (typeArg: string, options: RunOptions, command: Command) => {
      if (!(typeArg in REPORT_ROUTES)) {
        throw new CliError(EXIT.USAGE, `Unknown report type ${typeArg}. Valid: ${Object.keys(REPORT_ROUTES).join(", ")}`);
      }
      const type = typeArg as ReportType;
      const context = resolveCommandContext(command);
      const input = options.file ? readObjectBody(options.file) : {};
      const supplied: Record<string, unknown> = {
        startDate: options.startDate,
        endDate: options.endDate,
        timeZoneId: options.timeZoneId,
        customerId: options.customerId,
        endpointId: options.endpointId,
        flowId: options.flowId,
        metricName: options.metricName,
        specificState: options.specificState,
        includeArchivedSessions: options.includeArchivedSessions,
        includeCustomerIds: options.includeCustomerIds,
        syncDocumoNumbers: options.syncDocumoNumbers,
        types: options.endpointType && options.endpointType.length > 0 ? options.endpointType : undefined,
        emailAddressToNotify: options.email,
        webhookUrl: options.webhookUrl,
      };
      const body: Record<string, unknown> = { ...input, accountId: input.accountId ?? requireAccountId(context) };
      for (const [key, value] of Object.entries(supplied)) {
        if (value !== undefined) body[key] = value;
      }
      await executeJsonWrite(context, {
        method: "POST",
        path: REPORT_ROUTES[type],
        body,
        summary: `Queue ${type} report on ${context.accountName}; fields: ${changedKeys(body)}`,
      });
    });

  addGlobalFlags(root.command("download"))
    .argument("<id>", "Completed report id")
    .description("Download a completed report workbook; requires --out <path>")
    .action(async (id: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      if (!context.globals.out) throw new CliError(EXIT.USAGE, "report download requires --out <path>");
      const route = `/reports/${encoded(id)}.xlsx`;
      if (context.globals.dryRun) {
        emit(planRequest("GET", context.env.profile.baseUrl, route, {}), { ...context.globals, out: undefined });
        return;
      }
      printBanner(context.env, context.globals, context.user);
      const result = await ssDownload(route, {
        baseUrl: context.env.profile.baseUrl,
        cookies: context.cookies,
      });
      writeBinaryOut(context.globals.out, result.data, context.globals);
    });

  addGlobalFlags(root.command("delete"))
    .argument("<id>", "Report id")
    .description("Delete a report and its generated workbook; staging requires --force")
    .action(async (id: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "DELETE",
        path: `/reports/${encoded(id)}`,
        summary: `delete report ${id} from ${context.accountName}`,
      }, { destructive: true });
    });

  return root;
}

function collectValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
