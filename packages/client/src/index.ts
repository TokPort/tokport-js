import { MODEL_MODALITY, type ModelId } from "./models";
import { readSse } from "./sse";
import {
  TokPortError,
  type ClientOptions,
  type ImageResult,
  type Input,
  type ModelInfo,
  type QueueStatus,
  type SubmitOptions,
  type SubscribeOptions,
  type TaskKind,
  type VideoResult,
  type VideoRunResult,
} from "./types";

export * from "./types";
export { MODEL_IDS, MODEL_MODALITY, type ModelId } from "./models";
export { verifyWebhook, type WebhookPayload } from "./webhook";

const DEFAULT_BASE = "https://api.tokport.io";
const DEFAULT_SITE = "https://tokport.io";
export const PROXY_TARGET_HEADER = "x-tokport-target-path";

/** A model id; known ids autocomplete, any newer id from https://tokport.io/models works too. */
export type Model = ModelId | (string & {});

const VIDEO_HINT = /video|seedance|kling|hailuo|wan|sora|veo|vidu|jimeng|minimax/i;

function hasImage(input: Input): boolean {
  return Boolean(input.image) || Boolean(input.input_reference) || (Array.isArray(input.images) && input.images.length > 0);
}

/** Task for a sync call: the model's modality from the catalog, else a guess from its id. */
export function inferTask(model: string, input: Input): TaskKind {
  const modality = MODEL_MODALITY[model];
  const video = modality ? modality === "video" : VIDEO_HINT.test(model);
  if (video) return hasImage(input) ? "image-to-video" : "text-to-video";
  return hasImage(input) ? "image-to-image" : "text-to-image";
}

export function endpointFor(task: TaskKind): string {
  if (task.endsWith("video")) return "/v1/videos";
  return task === "image-to-image" ? "/v1/images/edits" : "/v1/images/generations";
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new TokPortError("aborted", 499, "aborted"));
    });
  });

export class TokPort {
  readonly queue: Queue;
  readonly models: Models;
  readonly storage = {
    /** Turn a File/Blob/ArrayBuffer/Uint8Array into a data: URL for image inputs. */
    async toDataUrl(data: Blob | ArrayBuffer | Uint8Array, mime = "image/png"): Promise<string> {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data instanceof ArrayBuffer ? data : await data.arrayBuffer());
      const type = data instanceof Blob && data.type ? data.type : mime;
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const b64 = btoa(binary); // global in Node 18+, Bun, Deno and browsers
      return `data:${type};base64,${b64}`;
    },
  };
  private readonly opts: Required<Pick<ClientOptions, "baseUrl" | "queueUrl" | "siteUrl">> & ClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.opts = { ...options, baseUrl, queueUrl: (options.queueUrl ?? baseUrl).replace(/\/$/, ""), siteUrl: (options.siteUrl ?? DEFAULT_SITE).replace(/\/$/, "") };
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (!options.apiKey && !options.proxyUrl) throw new TokPortError("Provide apiKey or proxyUrl", 0, "config");
    this.queue = new Queue(this);
    this.models = new Models(this);
  }

  /** @internal */
  async request<T>(base: "api" | "queue" | "site", path: string, init: RequestInit & { raw?: boolean } = {}): Promise<T> {
    const target = `${base === "api" ? this.opts.baseUrl : base === "queue" ? this.opts.queueUrl : this.opts.siteUrl}${path}`;
    const headers = new Headers(init.headers);
    if (!headers.has("content-type") && init.body && typeof init.body === "string") headers.set("content-type", "application/json");
    let url = target;
    if (this.opts.proxyUrl) {
      url = this.opts.proxyUrl;
      headers.set(PROXY_TARGET_HEADER, target);
    } else if (this.opts.apiKey && base !== "site") {
      headers.set("authorization", `Bearer ${this.opts.apiKey}`);
    }
    const res = await this.fetchImpl(url, { ...init, headers });
    if (init.raw) return res as unknown as T;
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok && res.status !== 202) {
      const err = (body as { error?: { message?: string; code?: string } } | null)?.error;
      throw new TokPortError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code ?? `http_${res.status}`, body, res.headers.get("x-oneapi-request-id") ?? undefined);
    }
    return body as T;
  }

  /** Synchronous call. Images answer inline; videos submit then poll until done and download the clip. */
  async run(model: Model, input: Input, options: { task?: TaskKind; pollMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ImageResult | VideoRunResult> {
    const task = options.task ?? inferTask(model, input);
    const endpoint = endpointFor(task);
    const body = JSON.stringify({ model, ...input });
    if (endpoint !== "/v1/videos") return this.request<ImageResult>("api", endpoint, { method: "POST", body });
    const submitted = await this.request<{ id: string }>("api", "/v1/videos", { method: "POST", body });
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    for (;;) {
      await sleep(options.pollMs ?? 5000, options.signal);
      const status = await this.request<{ id: string; status: string; progress: number; error?: { message?: string; code?: string } }>("api", `/v1/videos/${encodeURIComponent(submitted.id)}`);
      if (status.status === "completed") {
        const res = await this.request<Response>("api", `/v1/videos/${encodeURIComponent(submitted.id)}/content`, { raw: true });
        if (!res.ok) throw new TokPortError(`content download failed (${res.status})`, res.status, "content");
        return { ...status, status: "completed", bytes: new Uint8Array(await res.arrayBuffer()), content_type: res.headers.get("content-type") ?? "video/mp4" } as VideoRunResult;
      }
      if (status.status === "failed") throw new TokPortError(status.error?.message ?? "video task failed", 422, status.error?.code ?? "task_failed", status);
      if (Date.now() > deadline) throw new TokPortError("timed out waiting for the video", 408, "timeout");
    }
  }

  /** Submit to the queue, follow status (SSE, falling back to polling), return the result. */
  async subscribe(model: Model, input: Input, options: SubscribeOptions = {}): Promise<ImageResult | VideoResult> {
    const submitted = await this.queue.submit(model, input, options);
    options.onQueueUpdate?.(submitted);
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    let last: QueueStatus = submitted;
    try {
      for await (const status of this.queue.stream(model, submitted.request_id, { logs: options.logs, signal: options.signal })) {
        last = status;
        options.onQueueUpdate?.(status);
        if (status.status === "COMPLETED" || status.status === "FAILED" || status.status === "CANCELLED") break;
        if (Date.now() > deadline) throw new TokPortError("timed out waiting for the request", 408, "timeout");
      }
    } catch (err) {
      if (err instanceof TokPortError && err.code === "timeout") throw err;
      // stream unavailable (proxy without SSE, network blip): poll instead
      while (last.status === "IN_QUEUE" || last.status === "IN_PROGRESS") {
        await sleep(2000, options.signal);
        last = await this.queue.status(model, submitted.request_id, { logs: options.logs });
        options.onQueueUpdate?.(last);
        if (Date.now() > deadline) throw new TokPortError("timed out waiting for the request", 408, "timeout");
      }
    }
    if (last.status === "FAILED") throw new TokPortError(last.error?.message ?? "request failed", 422, last.error?.code ?? "failed", last, last.gateway_request_id);
    if (last.status === "CANCELLED") throw new TokPortError("request was cancelled", 410, "cancelled", last);
    return this.queue.result(model, submitted.request_id);
  }
}

export class Queue {
  constructor(private readonly client: TokPort) {}

  async submit(model: Model, input: Input, options: SubmitOptions = {}): Promise<QueueStatus> {
    const params = new URLSearchParams();
    if (options.task) params.set("task", options.task);
    if (options.webhookUrl) params.set("webhook", options.webhookUrl);
    const qs = params.toString();
    return this.client.request<QueueStatus>("queue", `/queue/v1/${encodeURIComponent(model)}${qs ? `?${qs}` : ""}`, {
      method: "POST",
      body: JSON.stringify(input),
      headers: options.priority ? { "x-tokport-priority": options.priority } : {},
    });
  }

  status(model: string, requestId: string, options: { logs?: boolean } = {}): Promise<QueueStatus> {
    return this.client.request<QueueStatus>("queue", `/queue/v1/${encodeURIComponent(model)}/requests/${requestId}/status${options.logs ? "?logs=1" : ""}`);
  }

  /** Status frames until a terminal state (server-sent events). */
  async *stream(model: string, requestId: string, options: { logs?: boolean; signal?: AbortSignal } = {}): AsyncGenerator<QueueStatus> {
    const res = await this.client.request<Response>("queue", `/queue/v1/${encodeURIComponent(model)}/requests/${requestId}/status/stream${options.logs ? "?logs=1" : ""}`, {
      raw: true,
      headers: { accept: "text/event-stream" },
      signal: options.signal,
    });
    if (!res.ok || !res.body) throw new TokPortError(`stream unavailable (${res.status})`, res.status, "stream");
    yield* readSse<QueueStatus>(res.body, options.signal);
  }

  /** The result; waits up to `timeout` seconds server-side (max 60) before answering with the status. */
  async result<T = ImageResult | VideoResult>(model: string, requestId: string, options: { timeout?: number } = {}): Promise<T> {
    const body = await this.client.request<T | QueueStatus>("queue", `/queue/v1/${encodeURIComponent(model)}/requests/${requestId}${options.timeout ? `?timeout=${options.timeout}` : ""}`);
    const maybe = body as QueueStatus;
    if (maybe && typeof maybe === "object" && "status" in maybe && (maybe.status === "IN_QUEUE" || maybe.status === "IN_PROGRESS")) {
      throw new TokPortError(`request is still ${maybe.status}`, 202, "pending", maybe);
    }
    return body as T;
  }

  cancel(model: string, requestId: string): Promise<{ status: string; request_id: string }> {
    return this.client.request("queue", `/queue/v1/${encodeURIComponent(model)}/requests/${requestId}/cancel`, { method: "PUT" });
  }
}

export class Models {
  constructor(private readonly client: TokPort) {}

  async list(filter: { q?: string; modality?: "image" | "video"; vendor?: string; task?: TaskKind; available?: boolean } = {}): Promise<ModelInfo[]> {
    const params = new URLSearchParams();
    if (filter.q) params.set("q", filter.q);
    if (filter.modality) params.set("modality", filter.modality);
    if (filter.vendor) params.set("vendor", filter.vendor);
    if (filter.task) params.set("task", filter.task);
    if (filter.available) params.set("available", "1");
    const qs = params.toString();
    const body = await this.client.request<{ models: ModelInfo[] }>("site", `/api/models${qs ? `?${qs}` : ""}`);
    return body.models;
  }
}
