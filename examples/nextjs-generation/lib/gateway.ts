import { createHash, timingSafeEqual } from "node:crypto";

type Settings = { apiKey?: string; password?: string; baseUrl?: string; imageModel?: string; videoModel?: string };
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export function createGateway(settings: Settings, fetcher: Fetcher = fetch) {
  return async function handle(request: Request): Promise<Response> {
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
    if (!settings.apiKey || !settings.password) return json({ error: "Set TOKPORT_API_KEY and STARTER_PASSWORD on the server." }, 503);
    const hash = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(hash(request.headers.get("authorization") ?? ""), hash(`Bearer ${settings.password}`))) {
      return json({ error: "Incorrect starter password." }, 401);
    }
    try {
      const url = new URL(request.url);
      let path: string;
      let body: string | undefined;
      const download = url.searchParams.get("download") === "1";
      if (request.method === "POST") {
        const raw = await request.text();
        if (raw.length > 20_000) return json({ error: "Request too large." }, 413);
        let input: { kind?: string; prompt?: string };
        try { input = JSON.parse(raw); } catch { return json({ error: "Expected JSON." }, 400); }
        if (!input || !["image", "video"].includes(input.kind ?? "") || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 4000) {
          return json({ error: "Choose image or video and supply a prompt of 1–4000 characters." }, 400);
        }
        const video = input.kind === "video";
        path = video ? "/v1/videos" : "/v1/images/generations";
        body = JSON.stringify(video
          ? { model: settings.videoModel ?? "seedance-2-5", prompt: input.prompt.trim(), seconds: 5, ratio: "16:9" }
          : { model: settings.imageModel ?? "gpt-image-2", prompt: input.prompt.trim(), size: "1024x1024", n: 1 });
      } else if (request.method === "GET") {
        const id = url.searchParams.get("id") ?? "";
        if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) return json({ error: "Invalid video task ID." }, 400);
        path = `/v1/videos/${encodeURIComponent(id)}${download ? "/content" : ""}`;
      } else return json({ error: "Method not allowed." }, 405);

      const upstream = await fetcher(`${(settings.baseUrl ?? "https://api.tokport.io").replace(/\/$/, "")}${path}`, {
        method: request.method,
        headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
        body,
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(180_000)]),
      });
      // Do not echo provider error bodies: credentials and internal diagnostics can appear there.
      if (!upstream.ok) {
        const messages: Record<number, string> = { 401: "The server API key was rejected.", 402: "Insufficient TokPort balance.", 429: "Rate limited. Wait before retrying.", 404: "Task not found or expired." };
        await upstream.body?.cancel();
        return json({ error: messages[upstream.status] ?? `Generation API returned HTTP ${upstream.status}.` }, upstream.status);
      }
      if (request.method === "GET" && download) {
        return new Response(upstream.body, { headers: { "Content-Type": "video/mp4", "Content-Disposition": 'attachment; filename="tokport-video.mp4"', "Cache-Control": "no-store" } });
      }
      return json(await upstream.json());
    } catch (error) {
      const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      return json({ error: timeout ? "Request timed out or was cancelled. A submitted video may still be running; resume with its task ID." : "Unable to reach the generation API." }, timeout ? 504 : 502);
    }
  };
}
