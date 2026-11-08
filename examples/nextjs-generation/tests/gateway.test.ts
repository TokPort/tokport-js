import { describe, expect, test } from "bun:test";
import { createGateway, type Fetcher } from "../lib/gateway";

const settings = { apiKey: "upstream-secret", password: "demo-password", baseUrl: "https://mock.invalid" };
const req = (body?: unknown, query = "") => new Request(`http://localhost/api/generate${query}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { Authorization: "Bearer demo-password" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
describe("starter gateway", () => {
  test("rejects unauthenticated spending and missing configuration", async () => {
    const neverFetch = (() => { throw new Error("must not call upstream"); }) as Fetcher;
    expect((await createGateway(settings, neverFetch)(new Request("http://localhost"))).status).toBe(401);
    expect((await createGateway({}, neverFetch)(req({ kind: "image", prompt: "boat" }))).status).toBe(503);
  });
  test("forwards image input with a server-only key and model allowlist", async () => {
    const gateway = createGateway(settings, (async (url, init) => {
      expect(String(url)).toBe("https://mock.invalid/v1/images/generations");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer upstream-secret");
      expect(JSON.parse(init?.body as string)).toEqual({ model: "gpt-image-2", prompt: "boat", size: "1024x1024", n: 1 });
      return Response.json({ data: [{ url: "https://example.com/image.png" }] });
    }) as Fetcher);
    const response = await gateway(req({ kind: "image", prompt: "boat", model: "untrusted", n: 100 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain(settings.apiKey);
  });
  test("video submission, status and binary download use distinct paths", async () => {
    const paths: string[] = [];
    const gateway = createGateway(settings, (async (url, init) => {
      paths.push(String(url));
      if (init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toEqual({ model: "seedance-2-5", prompt: "boat", seconds: 5, ratio: "16:9" });
        return Response.json({ id: "video_123", status: "queued" });
      }
      return String(url).endsWith("/content") ? new Response(new Uint8Array([0, 1, 2, 3])) : Response.json({ id: "video_123", status: "completed" });
    }) as Fetcher);
    const submission = await (await gateway(req({ kind: "video", prompt: "boat" }))).json();
    expect(submission.id).toBe("video_123");
    expect((await (await gateway(req(undefined, "?id=video_123"))).json()).status).toBe("completed");
    const download = await gateway(req(undefined, "?id=video_123&download=1"));
    expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([0, 1, 2, 3]);
    expect(paths).toEqual(["https://mock.invalid/v1/videos", "https://mock.invalid/v1/videos/video_123", "https://mock.invalid/v1/videos/video_123/content"]);
  });
  test("rejects invalid prompts and path traversal before upstream", async () => {
    const gateway = createGateway(settings, (() => { throw new Error("must not call"); }) as Fetcher);
    for (const body of [null, {}, { kind: "image", prompt: " " }, { kind: "video", prompt: "x".repeat(4001) }]) expect((await gateway(req(body))).status).toBe(400);
    expect((await gateway(req(undefined, "?id=../balance"))).status).toBe(400);
  });
  test("preserves actionable status without exposing provider diagnostics", async () => {
    for (const status of [401, 402, 429, 500]) {
      let calls = 0;
      const gateway = createGateway(settings, (async () => { calls++; return Response.json({ error: settings.apiKey }, { status }); }) as Fetcher);
      const response = await gateway(req({ kind: "image", prompt: "boat" }));
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(settings.apiKey);
      expect(calls).toBe(1); // Never automatically retry a billed POST.
    }
  });
  test("reports timeouts", async () => {
    const gateway = createGateway(settings, (async () => { throw new DOMException("timeout", "TimeoutError"); }) as Fetcher);
    expect((await gateway(req({ kind: "video", prompt: "boat" }))).status).toBe(504);
  });
});
