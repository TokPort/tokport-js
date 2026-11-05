export type TaskKind = "text-to-image" | "image-to-image" | "text-to-video" | "image-to-video";

export type QueueState = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface QueueStatus {
  status: QueueState;
  request_id: string;
  response_url: string;
  status_url: string;
  cancel_url: string;
  queue_position?: number;
  gateway_request_id?: string;
  logs?: { timestamp: string; message: string }[];
  metrics?: { inference_time?: number };
  error?: { message: string; code?: string };
}

export interface ImageResult {
  created?: number;
  data: { url?: string; b64_json?: string; revised_prompt?: string }[];
  request_id?: string;
}

export interface VideoResult {
  request_id: string;
  task_id: string;
  status: "completed";
  video: { url: string; content_type: string } | null;
  artifacts: { key: string; type: string; content_type: string; url: string }[];
  seconds?: string;
  size?: string;
}

/** Synchronous video result (direct /v1/videos flow): the task object plus the downloaded bytes. */
export interface VideoRunResult {
  id: string;
  status: "completed";
  progress: number;
  model?: string;
  created_at?: number;
  completed_at?: number;
  /** MP4 bytes from GET /v1/videos/{id}/content */
  bytes: Uint8Array;
  content_type: string;
}

export interface ModelInfo {
  id: string;
  display_name: string;
  vendor: string;
  modality: "image" | "video";
  category: TaskKind | null;
  tasks: TaskKind[];
  tags: string[];
  description: string;
  status: "active" | "catalog";
  pricing: { price: number; unit: "image" | "second"; currency: "USD" } | null;
  added: string;
  endpoints: { task: TaskKind; path: string }[];
  urls: { page: string; playground: string; api: string; openapi: string; llms_txt: string };
  thumbnail_url: string | null;
}

export type Input = Record<string, unknown>;

export interface SubmitOptions {
  /** Force the task kind; inferred from the input otherwise. */
  task?: TaskKind;
  webhookUrl?: string;
  priority?: "normal" | "low";
}

export interface SubscribeOptions extends SubmitOptions {
  onQueueUpdate?: (status: QueueStatus) => void;
  /** Include worker logs in status updates. */
  logs?: boolean;
  /** Give up after this many milliseconds (default 10 minutes). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ClientOptions {
  /** API key (sk-…). Omit when using a proxy. */
  apiKey?: string;
  /** Relay base URL, e.g. https://api.tokport.io (default). */
  baseUrl?: string;
  /** Queue API base URL; defaults to baseUrl. */
  queueUrl?: string;
  /** Storefront URL for /api/models; defaults to https://tokport.io. */
  siteUrl?: string;
  /** Same-origin proxy route (see ./proxy); requests go there with the target path in a header. */
  proxyUrl?: string;
  fetch?: typeof fetch;
}

export class TokPortError extends Error {
  status: number;
  code: string;
  requestId?: string;
  body?: unknown;
  constructor(message: string, status: number, code = "error", body?: unknown, requestId?: string) {
    super(message);
    this.name = "TokPortError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.requestId = requestId;
  }
}
