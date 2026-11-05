import { describe, expect, test } from 'bun:test';
import { APICallError, LoadAPIKeyError, NoSuchModelError } from '@ai-sdk/provider';
import { generateImage } from 'ai';
import { createTokPort, tokport } from '../src/index.js';
import { PNG, bytes, json, mockFetch } from './mock-fetch.js';

const BASE = 'https://api.tokport.io/v1';
const GEN = `POST ${BASE}/images/generations`;
const EDIT = `POST ${BASE}/images/edits`;

const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64');

function callOptions(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'a red fox',
    n: 1,
    size: undefined,
    aspectRatio: undefined,
    seed: undefined,
    files: undefined,
    mask: undefined,
    providerOptions: {},
    ...overrides,
  } as Parameters<ReturnType<typeof tokport.image>['doGenerate']>[0];
}

describe('provider', () => {
  test('exposes image/imageModel/video/videoModel and spec v4 models', () => {
    const p = createTokPort({ apiKey: 'k' });
    expect(p.specificationVersion).toBe('v4');
    expect(p.image('gpt-image-2').specificationVersion).toBe('v4');
    expect(p.imageModel('qwen-image-v2').modelId).toBe('qwen-image-v2');
    expect(p.image('gpt-image-2').provider).toBe('tokport.image');
    expect(p.video('seedance-2-0').specificationVersion).toBe('v4');
    expect(p.videoModel('kling-3-0').provider).toBe('tokport.video');
  });

  test('languageModel and embeddingModel throw NoSuchModelError', () => {
    const p = createTokPort({ apiKey: 'k' });
    expect(() => p.languageModel('gpt-4o')).toThrow(NoSuchModelError);
    expect(() => p.embeddingModel('x')).toThrow(NoSuchModelError);
  });

  test('flags edit-capable models via supportsFileInputs', () => {
    const p = createTokPort({ apiKey: 'k' });
    expect(p.image('gpt-image-2').supportsFileInputs).toBe(true);
    expect(p.image('z-image-turbo-fast').supportsFileInputs).toBeUndefined();
  });

  test('missing API key raises LoadAPIKeyError', async () => {
    const saved = process.env.TOKPORT_API_KEY;
    delete process.env.TOKPORT_API_KEY;
    try {
      const { fetch } = mockFetch({});
      const model = createTokPort({ fetch }).image('gpt-image-2');
      await expect(model.doGenerate(callOptions())).rejects.toThrow(LoadAPIKeyError);
    } finally {
      if (saved != null) process.env.TOKPORT_API_KEY = saved;
    }
  });

  test('reads TOKPORT_API_KEY and honours baseURL + custom headers', async () => {
    const saved = process.env.TOKPORT_API_KEY;
    process.env.TOKPORT_API_KEY = 'env-key';
    try {
      const { fetch, calls } = mockFetch({
        'POST https://proxy.example.com/v1/images/generations': () => json({ data: [{ b64_json: b64(PNG) }] }),
      });
      const model = createTokPort({ baseURL: 'https://proxy.example.com/v1/', headers: { 'x-team': 'a' }, fetch }).image(
        'gpt-image-2',
      );
      await model.doGenerate(callOptions());
      expect(calls[0]!.headers.get('authorization')).toBe('Bearer env-key');
      expect(calls[0]!.headers.get('x-team')).toBe('a');
      expect(calls[0]!.headers.get('user-agent')).toContain('ai-sdk/tokport/');
    } finally {
      if (saved == null) delete process.env.TOKPORT_API_KEY;
      else process.env.TOKPORT_API_KEY = saved;
    }
  });
});

describe('image generation', () => {
  test('url response: passes n and size, downloads hosted images without leaking the key', async () => {
    const { fetch, calls } = mockFetch({
      [GEN]: () =>
        json({
          created: 1,
          data: [
            { url: 'https://media.tokport.io/out/a.png', revised_prompt: 'a red fox, studio' },
            { url: 'https://media.tokport.io/out/b.png' },
          ],
        }),
      'GET https://media.tokport.io/out/a.png': () => bytes(PNG, 'image/png'),
      'GET https://media.tokport.io/out/b.png': () => bytes(PNG, 'image/png'),
    });
    const p = createTokPort({ apiKey: 'sk-test', fetch });

    const result = await generateImage({
      model: p.image('gpt-image-2'),
      prompt: 'a red fox',
      n: 2,
      size: '1024x1536',
    });

    expect(calls[0]!.url).toBe(`${BASE}/images/generations`);
    expect(calls[0]!.body).toEqual({ model: 'gpt-image-2', prompt: 'a red fox', n: 2, size: '1024x1536' });
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sk-test');
    expect(calls[0]!.headers.get('content-type')).toContain('application/json');

    const downloads = calls.filter((c) => c.method === 'GET');
    expect(downloads).toHaveLength(2);
    for (const d of downloads) expect(d.headers.get('authorization')).toBeNull();

    expect(result.images).toHaveLength(2);
    expect(Array.from(result.images[0]!.uint8Array)).toEqual(Array.from(PNG));
    expect(result.image.mediaType).toBe('image/png');
    expect(result.providerMetadata.tokport!.images[0]).toEqual({
      url: 'https://media.tokport.io/out/a.png',
      revisedPrompt: 'a red fox, studio',
    });
  });

  test('b64_json response is returned as base64 without extra requests', async () => {
    const { fetch, calls } = mockFetch({
      [GEN]: () => json({ created: 1, data: [{ b64_json: b64(PNG) }] }),
    });
    const p = createTokPort({ apiKey: 'sk-test', fetch });

    const result = await generateImage({
      model: p.image('seedream-5-pro'),
      prompt: 'neon koi',
      providerOptions: { tokport: { response_format: 'b64_json', quality: 'high' } },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      model: 'seedream-5-pro',
      prompt: 'neon koi',
      n: 1,
      response_format: 'b64_json',
      quality: 'high',
    });
    expect(result.image.base64).toBe(b64(PNG));
  });

  test('splits n above maxImagesPerCall (4) into several requests', async () => {
    const { fetch, calls } = mockFetch({
      [GEN]: (call) =>
        json({ data: Array.from({ length: (call.body as { n: number }).n }, () => ({ b64_json: b64(PNG) })) }),
    });
    const result = await generateImage({
      model: createTokPort({ apiKey: 'k', fetch }).image('gpt-image-2'),
      prompt: 'x',
      n: 6,
    });
    expect(calls.map((c) => (c.body as { n: number }).n).sort()).toEqual([2, 4]);
    expect(result.images).toHaveLength(6);
  });

  test('aspectRatio and seed produce unsupported warnings and are not sent', async () => {
    const { fetch, calls } = mockFetch({ [GEN]: () => json({ data: [{ b64_json: b64(PNG) }] }) });
    const model = createTokPort({ apiKey: 'k', fetch }).image('gpt-image-2');
    const result = await model.doGenerate(callOptions({ aspectRatio: '16:9', seed: 7 }));
    expect(result.warnings.map((w) => (w.type === 'unsupported' ? w.feature : w.type))).toEqual([
      'aspectRatio',
      'seed',
    ]);
    expect(calls[0]!.body).toEqual({ model: 'gpt-image-2', prompt: 'a red fox', n: 1 });
  });

  test('image input goes to /images/edits as a URL or data: URL in JSON', async () => {
    const { fetch, calls } = mockFetch({ [EDIT]: () => json({ data: [{ b64_json: b64(PNG) }] }) });
    const p = createTokPort({ apiKey: 'k', fetch });

    await generateImage({
      model: p.image('gpt-image-2'),
      prompt: { images: ['https://example.com/ref.png'], text: 'make it blue' },
      size: '1024x1024',
    });
    expect(calls[0]!.url).toBe(`${BASE}/images/edits`);
    expect(calls[0]!.body).toEqual({
      model: 'gpt-image-2',
      prompt: 'make it blue',
      n: 1,
      size: '1024x1024',
      image: 'https://example.com/ref.png',
    });

    await p.image('gpt-image-2').doGenerate(
      callOptions({ files: [{ type: 'file', mediaType: 'image/png', data: PNG }] }),
    );
    expect((calls[1]!.body as { image: string }).image).toBe(`data:image/png;base64,${b64(PNG)}`);
  });
});

describe('error mapping', () => {
  test('OpenAI-style JSON error becomes APICallError with message and status', async () => {
    const { fetch } = mockFetch({
      [GEN]: () => json({ error: { message: 'Invalid token', type: 'new_api_error', code: 'invalid_api_key' } }, 401),
    });
    const model = createTokPort({ apiKey: 'bad', fetch }).image('gpt-image-2');
    const error = await model.doGenerate(callOptions()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(APICallError.isInstance(error)).toBe(true);
    const apiError = error as APICallError;
    expect(apiError.message).toBe('Invalid token');
    expect(apiError.statusCode).toBe(401);
    expect(apiError.isRetryable).toBe(false);
    expect((apiError.data as { error: { code: string } }).error.code).toBe('invalid_api_key');
  });

  test('429 and 5xx are retryable; generateImage retries then surfaces the error', async () => {
    const { fetch, calls } = mockFetch({
      [GEN]: () => json({ error: { message: 'upstream overloaded', code: 503 } }, 503),
    });
    const model = createTokPort({ apiKey: 'k', fetch }).image('gpt-image-2');
    const error = await generateImage({ model, prompt: 'x', maxRetries: 1 }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain('upstream overloaded');
    expect(calls).toHaveLength(2);
  });

  test('non-JSON error body falls back to the status text', async () => {
    const { fetch } = mockFetch({
      [GEN]: () => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    });
    const model = createTokPort({ apiKey: 'k', fetch }).image('gpt-image-2');
    const error = (await Promise.resolve(model.doGenerate(callOptions())).catch((e: unknown) => e)) as APICallError;
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error.statusCode).toBe(502);
    expect(error.isRetryable).toBe(true);
  });

  test('a response without url or b64_json is rejected', async () => {
    const { fetch } = mockFetch({ [GEN]: () => json({ data: [{}] }) });
    const model = createTokPort({ apiKey: 'k', fetch }).image('gpt-image-2');
    await expect(model.doGenerate(callOptions())).rejects.toThrow();
  });
});
