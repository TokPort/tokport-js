import { describe, expect, test } from "bun:test";
import { TokPort, TokPortError, endpointFor, inferTask } from "../src/index";
import { createProxy } from "../src/proxy";
import { readSse } from "../src/sse";
import { verifyWebhook } from "../src/webhook";

/** Fetch stub recording calls and answering from a script keyed by method+path. */
function stubFetch(routes: Record<string, (init: RequestInit, url: URL) => Response | Promise<Response>>) {
  const calls: { url: string; method: string; headers: Headers; body?: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ url: url.toString(), method, headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : undefined });
    const key = `${method} ${url.pathname}`;
    const handler = routes[key] ?? routes[`${method} *`];
    if (!handler) return new Response(JSON.stringify({ error: { message: `no stub for ${key}` } }), { status: 404 });
    return handler(init, url);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

describe("@tokport/client", () => {
  test("task inference and endpoints", () => {
    expect(inferTask("seedream-4-0", { prompt: "x" })).toBe("text-to-image");
    expect(inferTask("seedream-4-0", { prompt: "x", image: "data:…" })).toBe("image-to-image");
    expect(inferTask("kling-2-1", { prompt: "x" })).toBe("text-to-video");
    // catalog modality beats the name guess: these ids contain "kling" / "wan" but are image models
    expect(inferTask("kling-3-0-image", { prompt: "x" })).toBe("text-to-image");
    expect(inferTask("wan27-image", { prompt: "x" })).toBe("text-to-image");
    expect(endpointFor("image-to-image")).toBe("/v1/images/edits");
    expect(endpointFor("image-to-video")).toBe("/v1/videos");
  });

  test("run() posts images with the key and surfaces API errors", async () => {
    const { fetchImpl, calls } = stubFetch({
      "POST /v1/images/generations": () => json({ created: 1, data: [{ url: "https://x/1.png" }] }, 200, { "x-oneapi-request-id": "rid1" }),
    });
    const tokport = new TokPort({ apiKey: "sk-test", baseUrl: "https://api.test", fetch: fetchImpl });
    const out = await tokport.run("seedream-4-0", { prompt: "a cat", n: 1 });
    expect((out as { data: { url: string }[] }).data[0].url).toBe("https://x/1.png");
    expect(calls[0].headers.get("authorization")).toBe("Bearer sk-test");
    expect(JSON.parse(calls[0].body!)).toEqual({ model: "seedream-4-0", prompt: "a cat", n: 1 });

    const failing = stubFetch({ "POST /v1/images/generations": () => json({ error: { message: "insufficient balance", code: "quota" } }, 402, { "x-oneapi-request-id": "rid2" }) });
    const broke = new TokPort({ apiKey: "sk-test", baseUrl: "https://api.test", fetch: failing.fetchImpl });
    const err = await broke.run("seedream-4-0", { prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(TokPortError);
    expect(err.status).toBe(402);
    expect(err.code).toBe("quota");
    expect(err.requestId).toBe("rid2");
  });

  test("run() submits, polls and downloads video", async () => {
    let polls = 0;
    const { fetchImpl } = stubFetch({
      "POST /v1/videos": () => json({ id: "task_1", status: "queued" }),
      "GET /v1/videos/task_1": () => json({ id: "task_1", status: ++polls < 2 ? "in_progress" : "completed", progress: polls < 2 ? 50 : 100 }),
      "GET /v1/videos/task_1/content": () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }),
    });
    const tokport = new TokPort({ apiKey: "sk-test", baseUrl: "https://api.test", fetch: fetchImpl });
    const out = (await tokport.run("seedance-1-0-pro", { prompt: "waves", seconds: "5" }, { pollMs: 1 })) as { bytes: Uint8Array; content_type: string };
    expect(out.content_type).toBe("video/mp4");
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
    expect(polls).toBe(2);
  });

  test("queue.submit sends webhook, priority and task options", async () => {
    const { fetchImpl, calls } = stubFetch({
      "POST /queue/v1/seedream-4-0": (_init, url) => json({ status: "IN_QUEUE", request_id: "req_1", queue_position: 0, response_url: url.toString(), status_url: "", cancel_url: "" }),
    });
    const tokport = new TokPort({ apiKey: "sk-test", baseUrl: "https://api.test", fetch: fetchImpl });
    const s = await tokport.queue.submit("seedream-4-0", { prompt: "x" }, { webhookUrl: "https://hook", priority: "low", task: "text-to-image" });
    expect(s.request_id).toBe("req_1");
    const u = new URL(calls[0].url);
    expect(u.searchParams.get("webhook")).toBe("https://hook");
    expect(u.searchParams.get("task")).toBe("text-to-image");
    expect(calls[0].headers.get("x-tokport-priority")).toBe("low");
  });

  test("subscribe streams status frames then fetches the result", async () => {
    const frames = ['data: {"status":"IN_QUEUE","request_id":"req_1","queue_position":1}\n\n', ': keep-alive\n\n', 'data: {"status":"IN_PROGRESS","request_id":"req_1"}\n\ndata: {"status":"COMPLETED","request_id":"req_1","metrics":{"inference_time":1}}\n\n'];
    const { fetchImpl } = stubFetch({
      "POST /queue/v1/seedream-4-0": () => json({ status: "IN_QUEUE", request_id: "req_1", response_url: "", status_url: "", cancel_url: "" }),
      "GET /queue/v1/seedream-4-0/requests/req_1/status/stream": () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (const f of frames) c.enqueue(new TextEncoder().encode(f));
              c.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      "GET /queue/v1/seedream-4-0/requests/req_1": () => json({ created: 1, data: [{ url: "https://x/1.png" }], request_id: "req_1" }),
    });
    const tokport = new TokPort({ apiKey: "sk-test", baseUrl: "https://api.test", fetch: fetchImpl });
    const seen: string[] = [];
    const out = (await tokport.subscribe("seedream-4-0", { prompt: "x" }, { onQueueUpdate: (s) => seen.push(s.status) })) as { request_id: string };
    expect(out.request_id).toBe("req_1");
    expect(seen).toEqual(["IN_QUEUE", "IN_QUEUE", "IN_PROGRESS", "COMPLETED"]);
  });

  test("subscribe falls back to polling when the stream is unavailable and rejects failed requests", async () => {
    let n = 0;
    const { fetchImpl } = stubFetch({
      "POST /queue/v1/m": () => json({ status: "IN_QUEUE", request_id: "req_2", response_url: "", status_url: "", cancel_url: "" }),
      "GET /queue/v1/m/requests/req_2/status/stream": () => new Response("nope", { status: 500 }),
      "GET /queue/v1/m/requests/req_2/status": () => json({ status: ++n < 2 ? "IN_PROGRESS" : "FAILED", request_id: "req_2", error: { message: "boom", code: "x" } }),
    });
    const tokport = new TokPort({ apiKey: "sk-test", baseUrl: "https://api.test", fetch: fetchImpl });
    const err = await tokport.subscribe("m", { prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(TokPortError);
    expect(err.message).toBe("boom");
  });

  test("result() throws a pending error on 202", async () => {
    const { fetchImpl } = stubFetch({ "GET /queue/v1/m/requests/req_3": () => json({ status: "IN_PROGRESS", request_id: "req_3" }, 202) });
    const tokport = new TokPort({ apiKey: "sk-test", baseUrl: "https://api.test", fetch: fetchImpl });
    const err = await tokport.queue.result("m", "req_3").catch((e) => e);
    expect(err.code).toBe("pending");
  });

  test("proxy mode sends the target in a header and no key; models.list hits the site", async () => {
    const { fetchImpl, calls } = stubFetch({ "GET /api/tokport": () => json({ models: [{ id: "a" }] }) });
    const tokport = new TokPort({ proxyUrl: "https://app.test/api/tokport", siteUrl: "https://site.test", fetch: fetchImpl });
    const models = await tokport.models.list({ modality: "video" });
    expect(models[0].id).toBe("a");
    expect(calls[0].url).toBe("https://app.test/api/tokport");
    expect(calls[0].headers.get("x-tokport-target-path")).toBe("https://site.test/api/models?modality=video");
    expect(calls[0].headers.get("authorization")).toBeNull();
  });

  test("createProxy enforces host and path allowlists and injects the key", async () => {
    const upstream = stubFetch({ "POST /queue/v1/m": () => json({ status: "IN_QUEUE", request_id: "req_9", response_url: "", status_url: "", cancel_url: "" }) });
    const proxy = createProxy({ apiKey: "sk-secret", allowedHosts: ["api.test"], fetch: upstream.fetchImpl });
    const ok = await proxy(new Request("https://app.test/api/tokport", { method: "POST", headers: { "x-tokport-target-path": "https://api.test/queue/v1/m", "content-type": "application/json" }, body: "{}" }));
    expect(ok.status).toBe(200);
    expect(upstream.calls[0].headers.get("authorization")).toBe("Bearer sk-secret");
    const badHost = await proxy(new Request("https://app.test/api/tokport", { headers: { "x-tokport-target-path": "https://evil.test/queue/v1/m" } }));
    expect(badHost.status).toBe(412);
    const badPath = await proxy(new Request("https://app.test/api/tokport", { headers: { "x-tokport-target-path": "https://api.test/api/token/" } }));
    expect(badPath.status).toBe(412);
    const missing = await proxy(new Request("https://app.test/api/tokport"));
    expect(missing.status).toBe(400);
  });

  test("sse reader handles frames split across chunks", async () => {
    const chunks = ['data: {"a":1}\n\nda', 'ta: {"a":2}\n', "\n"];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
    const out: { a: number }[] = [];
    for await (const f of readSse<{ a: number }>(body)) out.push(f);
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("verifyWebhook accepts a valid signature and rejects tampering", async () => {
    const secret = "whsec_test";
    const body = JSON.stringify({ request_id: "req_1", gateway_request_id: "g", status: "OK", payload: { ok: true } });
    const ts = "1700000000";
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${body}`))), (b) => b.toString(16).padStart(2, "0")).join("");
    const headers = { "x-tokport-webhook-timestamp": ts, "x-tokport-webhook-signature": sig };
    expect((await verifyWebhook(body, headers, secret, { nowSec: 1700000010 }))?.request_id).toBe("req_1");
    expect(await verifyWebhook(body + " ", headers, secret, { nowSec: 1700000010 })).toBeNull();
    expect(await verifyWebhook(body, headers, secret, { nowSec: 1700009999 })).toBeNull();
    expect(await verifyWebhook(body, new Headers(headers), "other", { nowSec: 1700000010 })).toBeNull();
  });
});
