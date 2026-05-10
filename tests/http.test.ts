import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError, EXIT } from "../src/exit-codes.js";
import { buildUrl, planRequest, ssFetch } from "../src/http.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200, setCookies: string[] = []): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const c of setCookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

describe("buildUrl", () => {
  it("joins base + path", () => {
    expect(buildUrl("https://evovoice.io", "/sessions")).toBe("https://evovoice.io/sessions");
  });
  it("handles trailing slash and leading slash gracefully", () => {
    expect(buildUrl("https://evovoice.io/", "sessions")).toBe("https://evovoice.io/sessions");
  });
  it("encodes scalar query params", () => {
    const url = buildUrl("https://evovoice.io", "/sessions", { page: 0, log: "timed out" });
    expect(url).toMatch(/page=0/);
    expect(url).toMatch(/log=timed\+out/);
  });
  it("joins array query params as comma-separated", () => {
    const url = buildUrl("https://evovoice.io", "/sessions", { accountIds: ["a", "b"] });
    expect(url).toMatch(/accountIds=a%2Cb/);
  });
  it("omits undefined/null/empty values", () => {
    const url = buildUrl("https://evovoice.io", "/sessions", { page: undefined, log: "", accountIds: [] });
    expect(url).not.toMatch(/page=/);
    expect(url).not.toMatch(/log=/);
    expect(url).not.toMatch(/accountIds=/);
  });
});

describe("planRequest", () => {
  it("returns method/url/body without calling fetch", () => {
    const plan = planRequest("GET", "https://evovoice.io", "/sessions", { query: { page: 0 } });
    expect(plan).toEqual({
      method: "GET",
      url: expect.stringContaining("/sessions?page=0"),
      body: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ssFetch", () => {
  it("sends cookies in the Cookie header", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await ssFetch("GET", "/sessions", {
      baseUrl: "https://evovoice.io",
      cookies: { "ss-id": "abc", "ss-pid": "def" },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Cookie).toBe("ss-id=abc; ss-pid=def");
  });

  it("maps 401 to EXIT.AUTH", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    await expect(ssFetch("GET", "/sessions", { baseUrl: "https://x.test" }))
      .rejects.toMatchObject({ code: EXIT.AUTH });
  });

  it("maps 403 to EXIT.FORBIDDEN", async () => {
    fetchMock.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(ssFetch("GET", "/x", { baseUrl: "https://x.test" }))
      .rejects.toBeInstanceOf(CliError);
  });

  it("retries once on 429", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("rate", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const res = await ssFetch("GET", "/x", { baseUrl: "https://x.test", retry: true });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("captures Set-Cookie when captureCookies=true", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true }, 200, [
        "ss-id=AAA; Path=/; HttpOnly",
        "ss-pid=BBB; Path=/; HttpOnly",
      ]),
    );
    const res = await ssFetch("POST", "/auth/credentials", {
      baseUrl: "https://x.test",
      body: { provider: "credentials", userName: "u", password: "p", rememberMe: true },
      captureCookies: true,
    });
    expect(res.cookies).toEqual({ "ss-id": "AAA", "ss-pid": "BBB" });
  });

  it("returns parsed JSON body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ id: "1" }] }));
    const res = await ssFetch<{ items: { id: string }[] }>("GET", "/sessions", {
      baseUrl: "https://x.test",
    });
    expect(res.data.items[0].id).toBe("1");
  });

  it("serializes JSON body and sets Content-Type", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await ssFetch("PATCH", "/sessions/1", {
      baseUrl: "https://x.test",
      body: { callState: "Hold" },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe('{"callState":"Hold"}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
