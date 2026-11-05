# @tokport/client

TypeScript client for the [TokPort](https://tokport.io?utm_source=npm&utm_medium=readme&utm_campaign=tokport-js) image and video generation API. Zero dependencies; works in Node 18+, Bun, Deno and browsers (through the proxy).

```bash
npm install @tokport/client
```

Get an API key at [tokport.io/dashboard/keys](https://tokport.io/dashboard/keys?utm_source=npm&utm_medium=readme&utm_campaign=tokport-js). Model ids and prices: [tokport.io/models](https://tokport.io/models?utm_source=npm&utm_medium=readme&utm_campaign=tokport-js).

```ts
import { TokPort } from "@tokport/client";

const tokport = new TokPort({ apiKey: process.env.TOKPORT_API_KEY! });

// Synchronous (images answer inline; videos submit + poll for you)
const image = await tokport.run("gpt-image-2", { prompt: "a neon koi", size: "1024x1024" });
console.log(image.data[0].url);

// Queue: submit, follow progress, get the result
const result = await tokport.subscribe("seedance-2-0-fast", { prompt: "waves at night", seconds: "5" }, {
  onQueueUpdate: (s) => console.log(s.status, s.queue_position),
});
console.log(result.video.url);

// Or step by step
const { request_id } = await tokport.queue.submit("seedream-5-pro", { prompt: "poster" }, { webhookUrl: "https://example.com/hook" });
for await (const s of tokport.queue.stream("seedream-5-pro", request_id)) console.log(s.status);
const out = await tokport.queue.result("seedream-5-pro", request_id);
```

Browser apps keep the key on the server with the proxy:

```ts
// app/api/tokport/route.ts (Next.js)
import { createRouteHandler } from "@tokport/client/proxy";
export const { GET, POST, PUT } = createRouteHandler({ apiKey: process.env.TOKPORT_API_KEY! });

// browser
const tokport = new TokPort({ proxyUrl: "/api/tokport" });
```

Verify webhooks with `verifyWebhook(rawBody, headers, secret)`.

Full guide: [tokport.io/docs/clients](https://tokport.io/docs/clients?utm_source=npm&utm_medium=readme&utm_campaign=tokport-js).

## Other languages

[Python](https://github.com/TokPort/tokport-python) · [Go](https://github.com/TokPort/tokport-go) · [All SDKs](https://github.com/TokPort)

## License

MIT
