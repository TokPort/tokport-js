# @tokport/ai-sdk-provider

[Vercel AI SDK](https://ai-sdk.dev) provider for [TokPort](https://tokport.io?utm_source=npm&utm_medium=readme&utm_campaign=tokport-js), an image and video generation API. Use TokPort models with `generateImage` and `experimental_generateVideo`.

The TokPort API is OpenAI-compatible (`/v1/images/generations`, `/v1/images/edits`, `/v1/videos`), so the same API key also works with the OpenAI SDKs. This package adds typed model ids, image edits with URL or `data:` URL references, and the async video flow: submit, poll, download.

Requires AI SDK 7 (`ai@^7`) and Node.js 22 or newer.

## Install

Follow the repository's [source installation instructions](../../README.md#install-from-source) to clone and build the SDK, then install the built `packages/ai-sdk-provider` directory into your app. The import name remains `@tokport/ai-sdk-provider`.

Install AI SDK 7 and Zod separately in your app:

```bash
bun add 'ai@^7' 'zod@^4.1.8'
```

## Setup

Create an API key at [tokport.io](https://tokport.io?utm_source=npm&utm_medium=readme&utm_campaign=tokport-js) and set it as an environment variable:

```bash
export TOKPORT_API_KEY=sk-...
```

The default `tokport` instance reads `TOKPORT_API_KEY`. Use `createTokPort` for custom settings:

```ts
import { createTokPort } from '@tokport/ai-sdk-provider';

const tokport = createTokPort({
  apiKey: process.env.TOKPORT_API_KEY, // default: TOKPORT_API_KEY
  baseURL: 'https://api.tokport.io/v1', // default
  headers: { 'x-my-header': 'value' }, // optional, sent with every request
  fetch: customFetch, // optional
  video: { pollIntervalMs: 5000, pollTimeoutMs: 600_000 }, // optional defaults for video models
});
```

## Image generation

```ts
import { generateImage } from 'ai';
import { tokport } from '@tokport/ai-sdk-provider';

const { image } = await generateImage({
  model: tokport.image('gpt-image-2'),
  prompt: 'A neon koi swimming through clouds, cinematic lighting',
  size: '1024x1536',
  n: 1,
});

await Bun.write('koi.png', image.uint8Array); // or fs.writeFile
```

- `size` is passed through as `"WIDTHxHEIGHT"`. `aspectRatio` and `seed` are not supported and produce a warning.
- `n` above 4 is split into several requests automatically.
- Hosted image URLs are downloaded for you. The original URLs are in `providerMetadata.tokport.images`.
- Model-specific fields go in `providerOptions.tokport` and are sent as body parameters:

```ts
const { image } = await generateImage({
  model: tokport.image('gpt-image-2'),
  prompt: 'A product shot of a ceramic mug',
  providerOptions: {
    tokport: { quality: 'high', response_format: 'b64_json' },
  },
});
```

### Image editing

Pass reference images in the prompt. They are sent to `/v1/images/edits` as a URL, or as a `data:` URL for bytes and base64 input.

```ts
const { image } = await generateImage({
  model: tokport.image('gpt-image-2'),
  prompt: {
    images: ['https://example.com/product.png'],
    text: 'Put the product on a marble pedestal with soft studio lighting',
  },
});
```

Not every model accepts reference images. `tokport.image(id).supportsFileInputs` is `true` for models known to support edits; check the model page for the rest.

## Video generation

Video generation is async on TokPort. The model submits the task (`POST /v1/videos`), polls `GET /v1/videos/{id}` until it is `completed` or `failed`, then downloads the MP4 from `GET /v1/videos/{id}/content`.

```ts
import { experimental_generateVideo as generateVideo } from 'ai';
import { tokport } from '@tokport/ai-sdk-provider';

const { video } = await generateVideo({
  model: tokport.video('seedance-2-0'),
  prompt: 'A cat walking on a treadmill, handheld camera',
  duration: 5, // sent as seconds: "5"
  aspectRatio: '16:9', // sent as ratio
  abortSignal: AbortSignal.timeout(15 * 60_000),
});

await Bun.write('cat.mp4', video.uint8Array);
```

Image to video: pass the first frame in the prompt (URL, base64 or bytes).

```ts
const { video } = await generateVideo({
  model: tokport.video('seedance-2-0'),
  prompt: { image: 'https://example.com/frame.png', text: 'Slow push-in, leaves moving in the wind' },
});
```

### Polling

There are two ways to control polling:

1. Model settings. The model polls inside `doGenerate`:

   ```ts
   tokport.video('kling-3-0', { pollIntervalMs: 3000, pollTimeoutMs: 20 * 60_000 });
   ```

   Defaults: 5 s interval, 10 min timeout. A timeout throws `TokPortVideoTimeoutError`. A failed task throws `TokPortVideoGenerationError` with the server's `message`, `code` and `videoId`.

2. The AI SDK `poll` option. The model also implements `doStart` / `doStatus`, so the SDK runs the loop:

   ```ts
   await generateVideo({
     model: tokport.video('kling-3-0'),
     prompt: 'Waves at dusk',
     poll: { intervalMs: 5000, timeoutMs: 600_000 },
   });
   ```

`abortSignal` is honoured in both modes. The task id is in `providerMetadata.tokport.videoId`.

Mapped options: `prompt`, `duration` → `seconds`, `aspectRatio` → `ratio`, `resolution` → `size`, image or first frame → `image`. `fps`, `seed`, `generateAudio`, last frames and `inputReferences` produce an "unsupported" warning; send model-specific fields with `providerOptions.tokport`.

## Models

See the full, current list with prices at **[tokport.io/models](https://tokport.io/models?utm_source=npm&utm_medium=readme&utm_campaign=tokport-js)** (machine-readable: `GET https://tokport.io/api/models`).

Model ids are typed for autocomplete, and any other id string is accepted. Examples:

| Type  | Model ids |
| ----- | --------- |
| Image | `gpt-image-2`, `gpt-image-2.5-flare`, `seedream-5-pro`, `qwen-image-v2`, `wan27-image`, `z-image-turbo-fast`, `nano-banana-3-pro`, `kling-3-0-image` |
| Video | `seedance-2-0`, `seedance-2-0-fast`, `seedance-2-5`, `kling-3-0`, `kling-o1`, `wan3-video`, `happyhorse-1-1` |

## Errors

API errors are thrown as `APICallError` from `@ai-sdk/provider`, with the server's `error.message`, the HTTP `statusCode` and the parsed body in `data`. 429 and 5xx responses are marked retryable, so the AI SDK retries them (`maxRetries`, default 2).

## Links

- Documentation: https://tokport.io/docs
- Models: https://tokport.io/models
- AI SDK: https://ai-sdk.dev

## Other languages

[Python](https://github.com/TokPort/tokport-python) · [Go](https://github.com/TokPort/tokport-go) · [All SDKs](https://github.com/TokPort)

## License

MIT
