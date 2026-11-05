import { describe, expect, test } from 'bun:test';
import { APICallError } from '@ai-sdk/provider';
import { experimental_generateVideo as generateVideo } from 'ai';
import {
  TokPortVideoGenerationError,
  TokPortVideoTimeoutError,
  createTokPort,
} from '../src/index.js';
import { MP4, bytes, json, mockFetch } from './mock-fetch.js';

const BASE = 'https://api.tokport.io/v1';
const SUBMIT = `POST ${BASE}/videos`;
const STATUS = `GET ${BASE}/videos/video_123`;
const CONTENT = `GET ${BASE}/videos/video_123/content`;

const task = (status: string, extra: Record<string, unknown> = {}) => () =>
  json({ id: 'video_123', object: 'video', status, progress: 0, created_at: 1, ...extra });

function happyRoutes() {
  return mockFetch({
    [SUBMIT]: task('queued'),
    [STATUS]: [task('queued'), task('in_progress', { progress: 50 }), task('completed', { progress: 100 })],
    [CONTENT]: () => bytes(MP4, 'video/mp4'),
  });
}

function callOptions(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'a cat on a treadmill',
    n: 1,
    aspectRatio: undefined,
    resolution: undefined,
    duration: undefined,
    fps: undefined,
    seed: undefined,
    image: undefined,
    frameImages: undefined,
    inputReferences: undefined,
    generateAudio: undefined,
    providerOptions: {},
    ...overrides,
  } as Parameters<ReturnType<ReturnType<typeof createTokPort>['video']>['doGenerate']>[0];
}

describe('video generation', () => {
  test('submit → poll → content download via experimental_generateVideo (doGenerate)', async () => {
    const { fetch, calls } = happyRoutes();
    const p = createTokPort({ apiKey: 'sk-test', fetch, video: { pollIntervalMs: 1 } });

    const { video, providerMetadata } = await generateVideo({
      model: p.video('seedance-2-0'),
      prompt: { image: 'https://example.com/frame.png', text: 'a cat on a treadmill' },
      duration: 5,
      aspectRatio: '9:16',
      resolution: '1280x720',
    });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([SUBMIT, STATUS, STATUS, STATUS, CONTENT]);
    expect(calls[0]!.body).toEqual({
      model: 'seedance-2-0',
      prompt: 'a cat on a treadmill',
      seconds: '5',
      ratio: '9:16',
      size: '1280x720',
      image: 'https://example.com/frame.png',
    });
    for (const call of calls) expect(call.headers.get('authorization')).toBe('Bearer sk-test');

    expect(video.mediaType).toBe('video/mp4');
    expect(Array.from(video.uint8Array)).toEqual(Array.from(MP4));
    expect(providerMetadata.tokport).toMatchObject({ videoId: 'video_123', status: 'completed', progress: 100 });
  });

  test('SDK-driven polling via doStart/doStatus when `poll` is passed', async () => {
    const { fetch, calls } = happyRoutes();
    const p = createTokPort({ apiKey: 'k', fetch });

    const { video } = await generateVideo({
      model: p.video('kling-3-0'),
      prompt: 'waves at dusk',
      poll: { intervalMs: 1, timeoutMs: 5_000 },
    });

    expect(calls.filter((c) => c.url.endsWith('/videos/video_123'))).toHaveLength(3);
    expect(calls[0]!.body).toEqual({ model: 'kling-3-0', prompt: 'waves at dusk' });
    expect(Array.from(video.uint8Array)).toEqual(Array.from(MP4));
  });

  test('doStatus maps queued/completed/failed', async () => {
    const { fetch } = mockFetch({
      [STATUS]: [
        task('queued'),
        task('failed', { error: { code: 'content_policy', message: 'prompt rejected' } }),
      ],
    });
    const model = createTokPort({ apiKey: 'k', fetch }).video('seedance-2-0');
    expect((await model.doStatus({ operation: { id: 'video_123' } })).status).toBe('pending');
    const failed = await model.doStatus({ operation: { id: 'video_123' } });
    expect(failed).toMatchObject({ status: 'error', error: 'prompt rejected' });
    await expect(model.doStatus({ operation: 'nope' })).rejects.toThrow('Invalid TokPort video operation');
  });

  test('failed task: doGenerate throws TokPortVideoGenerationError, no content download', async () => {
    const { fetch, calls } = mockFetch({
      [SUBMIT]: task('queued'),
      [STATUS]: [task('in_progress'), task('failed', { error: { code: 'upstream_error', message: 'generation failed upstream' } })],
    });
    const model = createTokPort({ apiKey: 'k', fetch, video: { pollIntervalMs: 1 } }).video('seedance-2-0');

    const error = await model.doGenerate(callOptions()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokPortVideoGenerationError);
    expect((error as TokPortVideoGenerationError).message).toBe('generation failed upstream');
    expect((error as TokPortVideoGenerationError).code).toBe('upstream_error');
    expect((error as TokPortVideoGenerationError).videoId).toBe('video_123');
    expect(calls.some((c) => c.url.endsWith('/content'))).toBe(false);
  });

  test('failed task surfaces through experimental_generateVideo with poll', async () => {
    const { fetch } = mockFetch({
      [SUBMIT]: task('queued'),
      [STATUS]: task('failed', { error: { message: 'out of credits' } }),
    });
    const model = createTokPort({ apiKey: 'k', fetch }).video('seedance-2-0');
    await expect(
      generateVideo({ model, prompt: 'x', poll: { intervalMs: 1, timeoutMs: 1_000 } }),
    ).rejects.toThrow('out of credits');
  });

  test('submit error is mapped to APICallError', async () => {
    const { fetch } = mockFetch({
      [SUBMIT]: () => json({ error: { message: 'model not found', type: 'invalid_request_error' } }, 400),
    });
    const model = createTokPort({ apiKey: 'k', fetch }).video('nope');
    const error = (await model.doGenerate(callOptions()).catch((e) => e)) as APICallError;
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('model not found');
  });

  test('times out after pollTimeoutMs with TokPortVideoTimeoutError', async () => {
    const { fetch } = mockFetch({ [SUBMIT]: task('queued'), [STATUS]: task('in_progress') });
    const model = createTokPort({ apiKey: 'k', fetch }).video('seedance-2-0', {
      pollIntervalMs: 5,
      pollTimeoutMs: 40,
    });
    const started = Date.now();
    const error = await model.doGenerate(callOptions()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokPortVideoTimeoutError);
    expect((error as TokPortVideoTimeoutError).timeoutMs).toBe(40);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('model settings override provider-level video defaults', async () => {
    const { fetch } = mockFetch({ [SUBMIT]: task('queued'), [STATUS]: task('in_progress') });
    const p = createTokPort({ apiKey: 'k', fetch, video: { pollIntervalMs: 60_000, pollTimeoutMs: 60_000 } });
    const error = await p
      .video('seedance-2-0', { pollIntervalMs: 2, pollTimeoutMs: 20 })
      .doGenerate(callOptions())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokPortVideoTimeoutError);
  });

  test('abort signal stops polling promptly', async () => {
    const { fetch, calls } = mockFetch({ [SUBMIT]: task('queued'), [STATUS]: task('in_progress') });
    const model = createTokPort({ apiKey: 'k', fetch }).video('seedance-2-0', { pollIntervalMs: 10_000 });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);

    const error = await model.doGenerate(callOptions({ abortSignal: controller.signal })).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0);
  });

  test('already-aborted signal never submits', async () => {
    const { fetch } = mockFetch({ [SUBMIT]: task('queued') });
    const model = createTokPort({ apiKey: 'k', fetch }).video('seedance-2-0');
    await expect(model.doGenerate(callOptions({ abortSignal: AbortSignal.abort() }))).rejects.toThrow();
  });

  test('unsupported inputs produce warnings; frames, bytes and providerOptions map to the body', async () => {
    const { fetch, calls } = happyRoutes();
    const model = createTokPort({ apiKey: 'k', fetch, video: { pollIntervalMs: 1 } }).video('seedance-2-0');
    const result = await model.doGenerate(
      callOptions({
        aspectRatio: 'adaptive',
        fps: 24,
        seed: 1,
        generateAudio: true,
        frameImages: [
          { frameType: 'first_frame', image: { type: 'file', mediaType: 'image/jpeg', data: 'QUJD' } },
          { frameType: 'last_frame', image: { type: 'url', url: 'https://example.com/last.png' } },
        ],
        providerOptions: { tokport: { watermark: false } },
      }),
    );
    expect(calls[0]!.body).toEqual({
      model: 'seedance-2-0',
      prompt: 'a cat on a treadmill',
      image: 'data:image/jpeg;base64,QUJD',
      watermark: false,
    });
    expect(result.warnings.map((w) => (w.type === 'unsupported' ? w.feature : w.type)).sort()).toEqual([
      'fps',
      'frameImages',
      'generateAudio',
      'seed',
    ]);
    expect(result.videos[0]).toMatchObject({ type: 'binary', mediaType: 'video/mp4' });
  });
});
