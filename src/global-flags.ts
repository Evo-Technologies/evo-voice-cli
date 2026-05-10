import { Command, Option } from "commander";

/**
 * Commander only matches options at the level they are declared. To let users
 * type `evov <cmd> --json --out path`, every leaf command has to repeat the
 * global flag set. Calling this on a subcommand keeps that ergonomic without
 * forcing parent-first ordering.
 */
export function addGlobalFlags(cmd: Command): Command {
  for (const opt of GLOBAL_OPTIONS) cmd.addOption(opt());
  return cmd;
}

const GLOBAL_OPTIONS: (() => Option)[] = [
  () => new Option("-j, --json", "Force JSON output (default when stdout is piped)"),
  () => new Option("-p, --plain", "Tab-separated output (top-level scalars only)"),
  () => new Option("--select <fields>", "Comma-separated list of top-level fields to keep"),
  () => new Option("--fields <fields>", "Alias for --select").hideHelp(),
  () => new Option("--out <path>", 'Write JSON to <path>; print {"path":...} to stdout'),
  () => new Option("-n, --dry-run", "Print the planned request and exit without calling the API"),
  () => new Option("--no-input", "Never prompt; fail if input is required"),
  () => new Option("--force", "Skip destructive-action confirmation (staging only)"),
  () => new Option("--yes", "Alias for --force").hideHelp(),
  () => new Option("-v, --verbose", "Verbose progress to stderr"),
  () => new Option("--quiet", "Suppress the env/account banner on stderr"),
  () => new Option("--env <name>", "Override active env for this call (prod|staging)"),
  () => new Option("--account-id <id>", "Override active account by id for this call"),
  () => new Option("--account-name <name>", "Override active account by name for this call"),
];

/** Normalize alias flags in a preAction hook on the root command. */
export function normalizeAliases(_thisCmd: Command, actionCmd: Command): void {
  const o = actionCmd.opts() as Record<string, unknown>;
  if (o.fields && !o.select) actionCmd.setOptionValueWithSource("select", o.fields, "cli");
  if (o.yes && !o.force) actionCmd.setOptionValueWithSource("force", true, "cli");
}
