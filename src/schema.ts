import type { Command, Option } from "commander";

interface SerializedOption {
  flags: string;
  description: string;
  defaultValue?: unknown;
  required: boolean;
  optional: boolean;
}

interface SerializedCommand {
  name: string;
  description: string;
  usage: string;
  aliases: string[];
  arguments: { name: string; description: string; required: boolean; variadic: boolean }[];
  options: SerializedOption[];
  subcommands: SerializedCommand[];
}

export function serializeCommand(cmd: Command): SerializedCommand {
  return {
    name: cmd.name(),
    description: cmd.description(),
    usage: cmd.usage(),
    aliases: cmd.aliases(),
    arguments: cmd.registeredArguments.map((arg) => ({
      name: arg.name(),
      description: arg.description,
      required: arg.required,
      variadic: arg.variadic,
    })),
    options: cmd.options.map(serializeOption),
    subcommands: cmd.commands.map(serializeCommand),
  };
}

function serializeOption(opt: Option): SerializedOption {
  return {
    flags: opt.flags,
    description: opt.description,
    defaultValue: opt.defaultValue,
    required: opt.required ?? false,
    optional: opt.optional ?? false,
  };
}

export function findSubcommand(root: Command, pathParts: string[]): Command | null {
  let cur: Command = root;
  for (const part of pathParts) {
    const next = cur.commands.find(
      (c) => c.name() === part || c.aliases().includes(part),
    );
    if (!next) return null;
    cur = next;
  }
  return cur;
}
