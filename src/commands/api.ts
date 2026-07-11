import fs from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";

import {
  loadConfig,
  requireAuthenticated,
  resolveActiveEnv,
  type EnvName,
} from "../config.js";
import { CliError, EXIT } from "../exit-codes.js";
import { addGlobalFlags } from "../global-flags.js";
import { planRequest, ssDownload, ssFetch, type MultipartRequestBody } from "../http.js";
import { emit, printBanner, readBodyFromFlag, writeBinaryOut, type GlobalFlags } from "../output.js";
import { executeWrite } from "../write-gate.js";

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

/**
 * Normalize a raw API path argument.
 *
 * - Leading slash is optional (`accounts` == `/accounts`), so Git Bash users
 *   can avoid MSYS path conversion entirely.
 * - A drive-letter path (e.g. `C:/Program Files/Git/accounts`) is the
 *   signature of MSYS mangling a leading-slash path; reject it with guidance
 *   rather than sending a nonsense URL.
 */
export function normalizeApiPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new CliError(EXIT.USAGE, "Empty API path");
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new CliError(
      EXIT.USAGE,
      `Path "${trimmed}" looks like a Windows path — Git Bash converted your leading slash. ` +
      `Either omit the leading slash (evov api GET sessions/active) or set MSYS_NO_PATHCONV=1.`,
    );
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseQueryPairs(pairs: string[]): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new CliError(EXIT.USAGE, `--query expects key=value, got "${pair}"`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function collect(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}

interface ApiOpts {
  file?: string;
  data?: string;
  query: string[];
  form: string[];
  force?: boolean;
  upload?: string;
  uploadName?: string;
  uploadField?: string;
  contentType?: string;
  download?: boolean;
}

export function buildApiCommand(): Command {
  const root = new Command("api").description(
    "Low-level escape hatch for internal callbacks and newly deployed endpoints. Supports JSON, multipart uploads, and binary downloads. " +
    "Reads run freely; writes go through the same prod two-phase gate as every other command.",
  );

  addGlobalFlags(root)
    .argument("<method>", `HTTP method (${METHODS.join("|")})`)
    .argument("<path>", "API path, leading slash optional, may embed a query string (e.g. sessions/active or /flows/{id})")
    .option("-f, --file <path>", "JSON body from file (use - for stdin)")
    .option("-d, --data <json>", "JSON body inline (small payloads)")
    .option("--upload <path>", "Multipart file upload; exact bytes are bound into prod confirmation tokens")
    .option("--upload-name <name>", "Remote multipart file name")
    .option("--upload-field <name>", "Multipart file field name (default: file)")
    .option("--content-type <type>", "Multipart file content type")
    .option("--download", "Treat a GET response as binary (requires --out)")
    .addOption(
      new Option("-q, --query <key=value>", "Query parameter (repeatable)").argParser(collect).default([] as string[]),
    )
    .addOption(
      new Option("--form <key=value>", "Multipart form field (repeatable; requires --upload)").argParser(collect).default([] as string[]),
    )
    .action(async (methodArg: string, pathArg: string, opts: ApiOpts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags & ApiOpts>();
      const method = methodArg.toUpperCase();
      if (!METHODS.includes(method)) {
        throw new CliError(EXIT.USAGE, `Unsupported method "${methodArg}" (expected ${METHODS.join("|")})`);
      }

      const path = normalizeApiPath(pathArg);
      const query = parseQueryPairs(opts.query ?? []);

      const bodySources = [opts.file, opts.data !== undefined ? "inline" : undefined, opts.upload].filter(Boolean);
      if (bodySources.length > 1) throw new CliError(EXIT.USAGE, "--file, --data, and --upload are mutually exclusive");
      let body: unknown;
      if (opts.file) body = readBodyFromFlag(opts.file);
      if (opts.data !== undefined) {
        try {
          body = JSON.parse(opts.data);
        } catch (err) {
          throw new CliError(EXIT.USAGE, `--data is not valid JSON: ${(err as Error).message}`);
        }
      }
      if (opts.upload) body = readMultipart(opts.upload, opts.form ?? [], opts.uploadName, opts.uploadField, opts.contentType);
      if (!opts.upload && (opts.form?.length || opts.uploadName || opts.uploadField || opts.contentType)) {
        throw new CliError(EXIT.USAGE, "--form, --upload-name, --upload-field, and --content-type require --upload");
      }
      if (body !== undefined && method === "GET") {
        throw new CliError(EXIT.USAGE, "GET requests cannot carry a body");
      }
      if (opts.download && method !== "GET") throw new CliError(EXIT.USAGE, "--download is only valid with GET");
      if (opts.download && !globals.out) throw new CliError(EXIT.USAGE, "--download requires --out <path>");

      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, globals.env as EnvName | undefined);
      const prof = requireAuthenticated(env);

      if (globals.dryRun) {
        const plannedBody = isMultipart(body)
          ? {
              multipart: true,
              fields: body.fields,
              file: {
                name: body.file.fileName,
                contentType: body.file.contentType,
                size: Buffer.byteLength(body.file.dataBase64, "base64"),
              },
            }
          : body;
        emit(planRequest(method, env.profile.baseUrl, path, { query, body: plannedBody }), {
          ...globals,
          out: opts.download ? undefined : globals.out,
        });
        return;
      }
      printBanner(env, globals, prof.user);

      if (method === "GET") {
        if (opts.download) {
          const res = await ssDownload(path, {
            baseUrl: env.profile.baseUrl,
            cookies: prof.cookies,
            query,
          });
          writeBinaryOut(globals.out!, res.data, globals);
          return;
        }
        const res = await ssFetch(method, path, {
          baseUrl: env.profile.baseUrl,
          cookies: prof.cookies,
          query,
        });
        emit(res.data, globals);
        return;
      }

      // DELETE is destructive even on staging — match `session delete`'s --force convention.
      if (method === "DELETE" && !globals.force) {
        throw new CliError(EXIT.USAGE, "DELETE via `evov api` requires --force");
      }

      const accountName = env.profile.accountName ?? "(unknown account)";
      const bodyKeys = body && typeof body === "object" ? Object.keys(body as Record<string, unknown>) : [];
      const result = await executeWrite(env, prof.cookies, {
        method: method as "POST" | "PATCH" | "PUT" | "DELETE",
        path,
        query,
        body,
        summary: `${method} ${path} on ${accountName} (${env.name})` +
          (bodyKeys.length ? `; fields: ${bodyKeys.join(",")}` : ""),
      }, globals);
      if (result !== undefined) emit(result, globals);
    });

  return root;
}

function readMultipart(
  filePath: string,
  pairs: string[],
  uploadName?: string,
  uploadField?: string,
  contentType?: string,
): MultipartRequestBody {
  const fields = parseQueryPairs(pairs) ?? {};
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    throw new CliError(EXIT.USAGE, `Unable to read ${filePath}: ${(error as Error).message}`);
  }
  return {
    __evovBodyType: "multipart",
    fields,
    file: {
      fieldName: uploadField ?? "file",
      fileName: uploadName ?? path.basename(filePath),
      contentType: contentType ?? "application/octet-stream",
      dataBase64: bytes.toString("base64"),
    },
  };
}

function isMultipart(value: unknown): value is MultipartRequestBody {
  return !!value && typeof value === "object" &&
    (value as { __evovBodyType?: unknown }).__evovBodyType === "multipart";
}
