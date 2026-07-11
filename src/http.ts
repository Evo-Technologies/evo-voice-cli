import { CliError, EXIT, type ExitCode } from "./exit-codes.js";
import type { EnvProfile } from "./config.js";

const VERSION = "0.2.0";

export interface SsFetchOptions {
  baseUrl: string;
  cookies?: Record<string, string>;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  retry?: boolean;
  /** When true, capture Set-Cookie headers from the response. Used by `auth login`. */
  captureCookies?: boolean;
}

/** Serializable multipart payload so production confirmations bind exact file bytes. */
export interface MultipartRequestBody {
  __evovBodyType: "multipart";
  fields: Record<string, string>;
  file: {
    fieldName: string;
    fileName: string;
    contentType: string;
    dataBase64: string;
  };
}

export interface SsFetchResult<T> {
  data: T;
  status: number;
  cookies?: Record<string, string>;
}

export interface PlannedRequest {
  method: string;
  url: string;
  body: unknown;
}

export interface DownloadResult {
  data: Uint8Array;
  status: number;
  contentType?: string;
  fileName?: string;
}

export function buildUrl(
  baseUrl: string,
  resourcePath: string,
  query?: SsFetchOptions["query"],
): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(resourcePath.replace(/^\//, ""), base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) {
        // ServiceStack accepts comma-joined or repeated keys; comma is shorter.
        if (v.length === 0) continue;
        url.searchParams.set(k, v.join(","));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

export function planRequest(
  method: string,
  baseUrl: string,
  resourcePath: string,
  opts: Pick<SsFetchOptions, "query" | "body">,
): PlannedRequest {
  return {
    method,
    url: buildUrl(baseUrl, resourcePath, opts.query),
    body: opts.body ?? null,
  };
}

function cookieHeader(cookies?: Record<string, string>): string | undefined {
  if (!cookies || Object.keys(cookies).length === 0) return undefined;
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

function parseSetCookie(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  // Node 18.14+ exposes getSetCookie(); fall back to raw if not available
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[]; raw?: () => Record<string, string[]> };
  const raw: string[] = typeof anyHeaders.getSetCookie === "function"
    ? anyHeaders.getSetCookie()
    : typeof anyHeaders.raw === "function"
      ? (anyHeaders.raw()["set-cookie"] ?? [])
      : [];
  for (const line of raw) {
    const firstSemi = line.indexOf(";");
    const pair = firstSemi === -1 ? line : line.slice(0, firstSemi);
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

export async function ssFetch<T = unknown>(
  method: string,
  resourcePath: string,
  opts: SsFetchOptions,
): Promise<SsFetchResult<T>> {
  const url = buildUrl(opts.baseUrl, resourcePath, opts.query);
  const headers: Record<string, string> = {
    "User-Agent": `evo-voice-cli/${VERSION}`,
    Accept: "application/json",
  };
  const cookieStr = cookieHeader(opts.cookies);
  if (cookieStr) headers["Cookie"] = cookieStr;

  const init: RequestInit = { method, headers, redirect: "manual" };
  if (opts.body !== undefined && opts.body !== null) {
    if (isMultipartBody(opts.body)) {
      const form = new FormData();
      for (const [key, value] of Object.entries(opts.body.fields)) form.append(key, value);
      const bytes = Buffer.from(opts.body.file.dataBase64, "base64");
      form.append(
        opts.body.file.fieldName,
        new Blob([bytes], { type: opts.body.file.contentType }),
        opts.body.file.fileName,
      );
      init.body = form;
    } else {
      headers["Content-Type"] = "application/json";
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }
  }

  const shouldRetry = opts.retry !== false;
  const res = await doFetch(url, init, shouldRetry);

  const setCookies = opts.captureCookies ? parseSetCookie(res) : undefined;

  if (res.status === 204) {
    return { data: undefined as T, status: 204, cookies: setCookies };
  }

  const text = await res.text();
  const data = text.length > 0 ? safeJson(text) : undefined;

  if (!res.ok) {
    throw new CliError(
      statusToExit(res.status),
      formatHttpError(method, url, res.status, data, text),
    );
  }
  return { data: data as T, status: res.status, cookies: setCookies };
}

export function isMultipartBody(body: unknown): body is MultipartRequestBody {
  return !!body && typeof body === "object" &&
    (body as { __evovBodyType?: unknown }).__evovBodyType === "multipart";
}

export async function ssDownload(
  resourcePath: string,
  opts: Pick<SsFetchOptions, "baseUrl" | "cookies" | "query" | "retry">,
): Promise<DownloadResult> {
  const url = buildUrl(opts.baseUrl, resourcePath, opts.query);
  const headers: Record<string, string> = {
    "User-Agent": `evo-voice-cli/${VERSION}`,
    Accept: "*/*",
  };
  const cookieStr = cookieHeader(opts.cookies);
  if (cookieStr) headers.Cookie = cookieStr;
  const response = await doFetch(url, { method: "GET", headers, redirect: "follow" }, opts.retry !== false);
  if (!response.ok) {
    const text = await response.text();
    const data = text.length > 0 ? safeJson(text) : undefined;
    throw new CliError(
      statusToExit(response.status),
      formatHttpError("GET", url, response.status, data, text),
    );
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const nameMatch = /filename\*?=(?:UTF-8''|\")?([^\";]+)/i.exec(disposition);
  return {
    data: new Uint8Array(await response.arrayBuffer()),
    status: response.status,
    contentType: response.headers.get("content-type") ?? undefined,
    fileName: nameMatch ? decodeURIComponent(nameMatch[1].trim()) : undefined,
  };
}

async function doFetch(url: string, init: RequestInit, shouldRetry: boolean): Promise<Response> {
  const res = await fetch(url, init);
  if (shouldRetry && (res.status === 429 || res.status >= 500)) {
    await sleep(1000);
    return fetch(url, init);
  }
  return res;
}

function statusToExit(status: number): ExitCode {
  if (status === 401) return EXIT.AUTH;
  if (status === 403) return EXIT.FORBIDDEN;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 429) return EXIT.RATE_LIMIT;
  if (status >= 500) return EXIT.RETRYABLE;
  return EXIT.ERR;
}

function formatHttpError(
  method: string,
  url: string,
  status: number,
  data: unknown,
  rawText: string,
): string {
  const detail = data && typeof data === "object" ? JSON.stringify(data) : rawText.slice(0, 500);
  return `${method} ${url} → ${status}\n${detail}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Auth helpers - reused by `evov auth login`

export interface AuthenticateBody {
  provider: "credentials";
  userName: string;
  password: string;
  rememberMe: boolean;
}

export async function postCredentials(
  baseUrl: string,
  userName: string,
  password: string,
): Promise<Record<string, string>> {
  const body: AuthenticateBody = { provider: "credentials", userName, password, rememberMe: true };
  const res = await ssFetch("POST", "/auth/credentials", {
    baseUrl, body, captureCookies: true, retry: false,
  });
  return res.cookies ?? {};
}

export interface AuthStatusResponse {
  id?: string;
  isAuthenticated?: boolean;
  firstName?: string;
  lastName?: string;
  name?: string;
  emailAddress?: string;
  roles?: string[];
  accountIds?: string[];
  accountNames?: string[];
  avatarUrl?: string;
  // ...there are more fields but these are what the CLI needs
}

export async function getAuthStatus(baseUrl: string, cookies: Record<string, string>): Promise<AuthStatusResponse> {
  const res = await ssFetch<AuthStatusResponse>("GET", "/auth/status", { baseUrl, cookies });
  return res.data;
}

export function isProfileAuthenticated(profile: Pick<EnvProfile, "cookies">): boolean {
  return !!profile.cookies && Object.keys(profile.cookies).length > 0;
}
