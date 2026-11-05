import type {
  Experimental_VideoModelV4 as VideoModelV4,
  Experimental_VideoModelV4CallOptions as VideoModelV4CallOptions,
  Experimental_VideoModelV4OperationStartResult as VideoModelV4OperationStartResult,
  Experimental_VideoModelV4OperationStatusResult as VideoModelV4OperationStatusResult,
  Experimental_VideoModelV4Result as VideoModelV4Result,
  JSONValue,
  SharedV4Warning,
} from '@ai-sdk/provider';
import {
  combineHeaders,
  createBinaryResponseHandler,
  createJsonResponseHandler,
  delay,
  getFromApi,
  postJsonToApi,
  zodSchema,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';
import type { TokPortVideoModelId } from './model-ids.js';
import {
  fileToImageReference,
  getTokPortOptions,
  tokportFailedResponseHandler,
  type TokPortModelConfig,
} from './shared.js';

export type TokPortVideoModelSettings = {
  /** Delay between status polls in `doGenerate`. Default: 5000 ms. */
  pollIntervalMs?: number;
  /** Give up waiting for the video after this long in `doGenerate`. Default: 600000 ms (10 min). */
  pollTimeoutMs?: number;
};

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_POLL_TIMEOUT_MS = 600_000;

const videoTaskSchema = z.object({
  id: z.string(),
  object: z.string().nullish(),
  status: z.string(),
  progress: z.number().nullish(),
  model: z.string().nullish(),
  created_at: z.number().nullish(),
  completed_at: z.number().nullish(),
  error: z
    .object({
      code: z.union([z.string(), z.number()]).nullish(),
      message: z.string().nullish(),
    })
    .nullish(),
});

type VideoTask = z.infer<typeof videoTaskSchema>;

const FAILED_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'expired', 'error']);

/** Thrown by `doGenerate` when TokPort reports the video task as failed. */
export class TokPortVideoGenerationError extends Error {
  readonly name = 'TokPortVideoGenerationError';
  constructor(
    message: string,
    readonly videoId: string,
    readonly code?: string | number,
  ) {
    super(message);
  }
}

/** Thrown by `doGenerate` when the task does not finish within `pollTimeoutMs`. */
export class TokPortVideoTimeoutError extends Error {
  readonly name = 'TokPortVideoTimeoutError';
  constructor(
    readonly videoId: string,
    readonly timeoutMs: number,
  ) {
    super(`TokPort video ${videoId} did not finish within ${timeoutMs}ms.`);
  }
}

type TokPortOperation = { id: string };

function parseOperation(operation: JSONValue): TokPortOperation {
  if (operation != null && typeof operation === 'object' && !Array.isArray(operation)) {
    const id = (operation as Record<string, JSONValue>).id;
    if (typeof id === 'string' && id.length > 0) return { id };
  }
  throw new Error('Invalid TokPort video operation: expected { id: string }.');
}

/**
 * Video model for TokPort's async videos API:
 * `POST /v1/videos` → poll `GET /v1/videos/{id}` → `GET /v1/videos/{id}/content`.
 *
 * Implements both `doGenerate` (polls internally, honouring
 * `pollIntervalMs` / `pollTimeoutMs` and the abort signal) and
 * `doStart` / `doStatus` (the AI SDK polls when `poll` is passed to
 * `experimental_generateVideo`).
 */
export class TokPortVideoModel implements VideoModelV4 {
  readonly specificationVersion = 'v4';
  readonly maxVideosPerCall = 1;

  get provider(): string {
    return this.config.provider;
  }

  constructor(
    readonly modelId: TokPortVideoModelId,
    private readonly settings: TokPortVideoModelSettings,
    private readonly config: TokPortModelConfig,
  ) {}

  private getArgs(options: VideoModelV4CallOptions) {
    const warnings: SharedV4Warning[] = [];
    const body: Record<string, unknown> = { model: this.modelId };

    if (options.prompt != null) body.prompt = options.prompt;
    if (options.duration != null) body.seconds = String(options.duration);
    if (options.aspectRatio != null && options.aspectRatio !== 'adaptive') {
      body.ratio = options.aspectRatio;
    }
    if (options.resolution != null) body.size = options.resolution;

    let image = options.image;
    for (const frame of options.frameImages ?? []) {
      if (frame.frameType === 'first_frame' && image == null) {
        image = frame.image;
      } else {
        warnings.push({
          type: 'unsupported',
          feature: 'frameImages',
          details:
            frame.frameType === 'last_frame'
              ? 'TokPort video models take a first frame only; the last frame was ignored.'
              : 'Only one first frame is supported; extra frames were ignored.',
        });
      }
    }
    if (image != null) body.image = fileToImageReference(image);

    if (options.inputReferences != null && options.inputReferences.length > 0) {
      warnings.push({
        type: 'unsupported',
        feature: 'inputReferences',
        details: 'Pass model-specific reference fields through providerOptions.tokport.',
      });
    }
    if (options.n > 1) {
      warnings.push({ type: 'unsupported', feature: 'n', details: 'TokPort generates one video per request.' });
    }
    if (options.fps != null) warnings.push({ type: 'unsupported', feature: 'fps' });
    if (options.seed != null) warnings.push({ type: 'unsupported', feature: 'seed' });
    if (options.generateAudio != null) warnings.push({ type: 'unsupported', feature: 'generateAudio' });

    Object.assign(body, getTokPortOptions(options.providerOptions));
    return { body, warnings };
  }

  private now(): Date {
    return this.config._internal?.currentDate?.() ?? new Date();
  }

  async doStart(options: VideoModelV4CallOptions): Promise<VideoModelV4OperationStartResult> {
    const { body, warnings } = this.getArgs(options);
    const { value: task, responseHeaders } = await postJsonToApi({
      url: `${this.config.baseURL}/videos`,
      headers: combineHeaders(this.config.headers(), options.headers),
      body,
      failedResponseHandler: tokportFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(zodSchema(videoTaskSchema)),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    });
    return {
      operation: { id: task.id },
      warnings,
      providerMetadata: { tokport: { videoId: task.id, status: task.status } },
      response: { timestamp: this.now(), modelId: this.modelId, headers: responseHeaders },
    };
  }

  async doStatus(options: {
    operation: JSONValue;
    abortSignal?: AbortSignal;
    headers?: Record<string, string | undefined>;
  }): Promise<VideoModelV4OperationStatusResult> {
    const { id } = parseOperation(options.operation);
    const headers = combineHeaders(this.config.headers(), options.headers);
    const { value: task, responseHeaders } = await getFromApi({
      url: `${this.config.baseURL}/videos/${encodeURIComponent(id)}`,
      headers,
      validateUrl: false,
      failedResponseHandler: tokportFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(zodSchema(videoTaskSchema)),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    });
    const response = { timestamp: this.now(), modelId: this.modelId, headers: responseHeaders };
    const metadata = taskMetadata(task);

    if (task.status === 'completed') {
      const { data, mediaType } = await this.downloadContent(id, headers, options.abortSignal);
      return {
        status: 'completed',
        videos: [{ type: 'binary', data, mediaType }],
        warnings: [],
        providerMetadata: { tokport: metadata },
        response,
      };
    }
    if (FAILED_STATUSES.has(task.status)) {
      return {
        status: 'error',
        error: task.error?.message ?? `TokPort video ${id} ${task.status}.`,
        providerMetadata: { tokport: metadata },
        response,
      };
    }
    return { status: 'pending', providerMetadata: { tokport: metadata }, response };
  }

  async doGenerate(options: VideoModelV4CallOptions): Promise<VideoModelV4Result> {
    const intervalMs = this.settings.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = this.settings.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const start = await this.doStart(options);
    const { id } = parseOperation(start.operation);
    const startedAt = Date.now();

    while (true) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) throw new TokPortVideoTimeoutError(id, timeoutMs);
      await delay(Math.min(intervalMs, timeoutMs - elapsed), { abortSignal: options.abortSignal });

      const status = await this.doStatus({
        operation: start.operation,
        abortSignal: options.abortSignal,
        headers: options.headers,
      });
      if (status.status === 'completed') {
        return {
          videos: status.videos,
          warnings: start.warnings,
          providerMetadata: status.providerMetadata,
          response: status.response,
        };
      }
      if (status.status === 'error') {
        const code = (status.providerMetadata?.tokport as { errorCode?: string | number } | undefined)?.errorCode;
        throw new TokPortVideoGenerationError(status.error, id, code);
      }
    }
  }

  private async downloadContent(
    id: string,
    headers: Record<string, string | undefined>,
    abortSignal?: AbortSignal,
  ): Promise<{ data: Uint8Array; mediaType: string }> {
    const { value, responseHeaders } = await getFromApi({
      url: `${this.config.baseURL}/videos/${encodeURIComponent(id)}/content`,
      headers,
      validateUrl: false,
      failedResponseHandler: tokportFailedResponseHandler,
      successfulResponseHandler: createBinaryResponseHandler(),
      abortSignal,
      fetch: this.config.fetch,
    });
    const contentType = responseHeaders?.['content-type']?.split(';')[0]?.trim();
    return { data: value, mediaType: contentType?.startsWith('video/') ? contentType : 'video/mp4' };
  }
}

function taskMetadata(task: VideoTask) {
  return {
    videoId: task.id,
    status: task.status,
    ...(task.progress != null ? { progress: task.progress } : {}),
    ...(task.error?.code != null ? { errorCode: task.error.code } : {}),
  };
}
