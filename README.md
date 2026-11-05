# TokPort TypeScript SDKs

[![CI](https://github.com/TokPort/tokport-js/actions/workflows/ci.yml/badge.svg)](https://github.com/TokPort/tokport-js/actions/workflows/ci.yml)

Official TypeScript/JavaScript packages for **[TokPort](https://tokport.io/?utm_source=github&utm_medium=readme&utm_campaign=tokport-js)**, the pay-as-you-go API for image and video generation. One API key gives you GPT Image, Nano Banana, Seedream, Seedance, Kling, Qwen Image, Wan and [30+ more models](https://tokport.io/models?utm_source=github&utm_medium=readme&utm_campaign=tokport-js).

| Package | npm | What it is |
| --- | --- | --- |
| [`@tokport/client`](packages/client) | [![npm](https://img.shields.io/npm/v/@tokport/client.svg)](https://www.npmjs.com/package/@tokport/client) | Zero-dependency client: sync calls, the queue (submit / status / stream / result / cancel), webhook verification and a server-side proxy for browser apps |
| [`@tokport/ai-sdk-provider`](packages/ai-sdk-provider) | [![npm](https://img.shields.io/npm/v/@tokport/ai-sdk-provider.svg)](https://www.npmjs.com/package/@tokport/ai-sdk-provider) | Vercel AI SDK provider: `generateImage` and `experimental_generateVideo` |

```bash
npm install @tokport/client
```

```ts
import { TokPort } from "@tokport/client";

const tokport = new TokPort({ apiKey: process.env.TOKPORT_API_KEY! });
const image = await tokport.run("gpt-image-2", { prompt: "a neon koi", size: "1024x1024" });
console.log(image.data[0].url);
```

Get an API key at **[tokport.io/dashboard/keys](https://tokport.io/dashboard/keys?utm_source=github&utm_medium=readme&utm_campaign=tokport-js)**. Docs: [tokport.io/docs/clients](https://tokport.io/docs/clients?utm_source=github&utm_medium=readme&utm_campaign=tokport-js) · Pricing: [tokport.io/pricing](https://tokport.io/pricing?utm_source=github&utm_medium=readme&utm_campaign=tokport-js)

Other languages: [Python](https://github.com/TokPort/tokport-python) · [Go](https://github.com/TokPort/tokport-go)

## Development

```bash
bun install
bun test packages
bun run build
bun run generate   # refresh model ids from https://tokport.io/api/models
```

Release: bump the package's `version`, then push a tag such as `client-v0.1.1` or `ai-sdk-provider-v0.1.1`.

## License

MIT
