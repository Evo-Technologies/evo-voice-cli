import fs from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";

import { CliError, EXIT } from "../exit-codes.js";
import { addGlobalFlags } from "../global-flags.js";
import type { MultipartRequestBody } from "../http.js";
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

const FILE_TYPES = [
  "Upload",
  "VoiceMessage",
  "CallRecording",
  "Fax",
  "Attachment",
  "FaxOutgoing",
  "LiveAnswerRecording",
];

interface FileListOptions extends PaginationOptions {
  customerId?: string[];
  sessionId?: string;
  name?: string;
  contentType?: string;
  type?: string;
  dateCreatedStart?: string;
  dateCreatedEnd?: string;
  userId?: string;
  transcription?: string;
}

export function buildFileCommand(): Command {
  const root = new Command("file").description("List, upload, update, and delete stored files and recordings");

  const list = addGlobalFlags(root.command("list"))
    .description("List file metadata for the active account (GET /files)")
    .option("--customer-id <id>", "Filter by customer id (repeatable)", collect, [] as string[])
    .option("--session-id <id>", "Filter by session id")
    .option("--name <text>", "Filter by file name prefix")
    .option("--content-type <type>", "Filter by content type prefix")
    .addOption(new Option("--type <type>", "Filter by file type").choices(FILE_TYPES))
    .option("--date-created-start <date>", "Start of creation date range")
    .option("--date-created-end <date>", "End of creation date range")
    .option("--user-id <id>", "Filter by user id")
    .option("--transcription <text>", "Search human or AI transcription text");
  addPaginationOptions(list).action(async (options: FileListOptions, command: Command) => {
    const context = resolveCommandContext(command);
    await executeRead(context, "/files", {
      ...paginationQuery(options),
      accountIds: [requireAccountId(context)],
      customerIds: optionalList(options.customerId),
      sessionId: options.sessionId,
      fileName: options.name,
      contentType: options.contentType,
      type: options.type,
      dateCreatedStart: options.dateCreatedStart,
      dateCreatedEnd: options.dateCreatedEnd,
      userId: options.userId,
      transcriptionContains: options.transcription,
    }, { emptyExit: true });
  });

  addGlobalFlags(root.command("get"))
    .argument("<id>", "File id")
    .description("Fetch one file's metadata, including its content URI")
    .action(async (id: string, _options, command: Command) => {
      await executeRead(resolveCommandContext(command), `/files/${encoded(id)}`);
    });

  addGlobalFlags(root.command("upload").alias("create"))
    .argument("<path>", "Local file to upload")
    .description("Upload a file as multipart/form-data (POST /files)")
    .option("--name <name>", "Remote file name (defaults to local basename)")
    .option("--content-type <type>", "MIME type (otherwise inferred from extension)")
    .option("--customer-id <id>", "Associate the file with a customer")
    .action(async (filePath: string, options: { name?: string; contentType?: string; customerId?: string }, command: Command) => {
      const context = resolveCommandContext(command);
      const body = multipartBody(filePath, {
        accountId: requireAccountId(context),
        ...(options.customerId ? { customerId: options.customerId } : {}),
      }, options.name, options.contentType);
      await executeJsonWrite(context, {
        method: "POST",
        path: "/files",
        body,
        summary: `Upload ${body.file.fileName} (${formatBytes(Buffer.byteLength(body.file.dataBase64, "base64"))}) to ${context.accountName}`,
      }, {
        planBody: {
          multipart: true,
          fields: body.fields,
          file: { name: body.file.fileName, contentType: body.file.contentType, size: Buffer.byteLength(body.file.dataBase64, "base64") },
        },
      });
    });

  addGlobalFlags(root.command("patch"))
    .argument("<id>", "File id")
    .description("Update file metadata and optionally replace its bytes")
    .option("-f, --file <path>", "JSON metadata body (use - for stdin)")
    .option("--content <path>", "Replacement file content")
    .option("--content-type <type>", "Replacement MIME type")
    .action(async (id: string, options: { file?: string; content?: string; contentType?: string }, command: Command) => {
      if (!options.file && !options.content) throw new CliError(EXIT.USAGE, "Provide --file and/or --content");
      const context = resolveCommandContext(command);
      const metadata = options.file ? readObjectBody(options.file) : {};
      const multipart = options.content
        ? multipartBody(options.content, scalarFields(metadata), undefined, options.contentType)
        : undefined;
      const body = multipart ?? metadata;
      const planBody = multipart
        ? {
            multipart: true,
            fields: multipart.fields,
            file: { name: multipart.file.fileName, contentType: multipart.file.contentType, size: Buffer.byteLength(multipart.file.dataBase64, "base64") },
          }
        : body;
      await executeJsonWrite(context, {
        method: "PATCH",
        path: `/files/${encoded(id)}`,
        body,
        summary: `Patch file ${id} on ${context.accountName}; fields: ${changedKeys(metadata)}${options.content ? ", replacement content" : ""}`,
      }, { planBody });
    });

  addGlobalFlags(root.command("delete"))
    .argument("<id>", "File id")
    .description("Delete a file and its backing content; staging requires --force")
    .action(async (id: string, _options, command: Command) => {
      const context = resolveCommandContext(command);
      await executeJsonWrite(context, {
        method: "DELETE",
        path: `/files/${encoded(id)}`,
        summary: `delete file ${id} from ${context.accountName}`,
      }, { destructive: true });
    });

  return root;
}

function multipartBody(
  filePath: string,
  fields: Record<string, string>,
  remoteName?: string,
  contentType?: string,
): MultipartRequestBody {
  if (filePath === "-") {
    throw new CliError(EXIT.USAGE, "Binary multipart input cannot use stdin; provide a file path");
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    throw new CliError(EXIT.USAGE, `Unable to read ${filePath}: ${(error as Error).message}`);
  }
  const fileName = remoteName ?? path.basename(filePath);
  return {
    __evovBodyType: "multipart",
    fields,
    file: {
      fieldName: "file",
      fileName,
      contentType: contentType ?? inferContentType(fileName),
      dataBase64: bytes.toString("base64"),
    },
  };
}

function scalarFields(body: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      throw new CliError(EXIT.USAGE, `Multipart metadata field ${key} must be a scalar value`);
    }
    fields[key] = String(value);
  }
  return fields;
}

function inferContentType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return ({
    ".aac": "audio/aac",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain",
    ".wav": "audio/wav",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
