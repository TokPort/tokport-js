/**
 * Server-side proxy so browser code never holds the API key. The client sends
 * requests to your route with the real target URL in `x-tokport-target-path`;
 * the proxy checks the host against an allowlist, injects the key, and streams
 * the response back (SSE included). Framework-agnostic: it is a
 * `(Request) => Promise<Response>` function, plus a Next.js convenience.
 */
export const PROXY_TARGET_HEADER = "x-tokport-target-path";

export interface ProxyOptions {
  apiKey: string;
  /** Hosts the proxy may forward to. Defaults to the TokPort API and site hosts. */
  allowedHosts?: string[];
  /** Restrict forwarded paths, e.g. [/^\/queue\/v1\//, /^\/v1\/images\//]. Default: /v1/*, /queue/*, /api/models. */
  allowedPaths?: RegExp[];
  fetch?: typeof fetch;
}

const DEFAULT_HOSTS = ["api.tokport.io", "tokport.io"];
const DEFAULT_PATHS = [/^\/v1\//, /^\/queue\/v1\//, /^\/api\/models$/];

export function createProxy(options: ProxyOptions): (req: Request) => Promise<Response> {
  const hosts = new Set(options.allowedHosts ?? DEFAULT_HOSTS);
  const paths = options.allowedPaths ?? DEFAULT_PATHS;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  return async (req: Request) => {
    const target = req.headers.get(PROXY_TARGET_HEADER);
    if (!target) return json({ error: { message: `missing ${PROXY_TARGET_HEADER} header`, code: "proxy_target" } }, 400);
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return json({ error: { message: "invalid target url", code: "proxy_target" } }, 400);
    }
    if (!hosts.has(url.host) && !hosts.has(url.hostname)) return json({ error: { message: `host ${url.host} is not allowed`, code: "proxy_host" } }, 412);
    if (!paths.some((p) => p.test(url.pathname))) return json({ error: { message: `path ${url.pathname} is not allowed`, code: "proxy_path" } }, 412);

    const headers = new Headers();
    for (const name of ["content-type", "accept", "x-tokport-priority", "x-tokport-webhook", "x-tokport-task"]) {
      const v = req.headers.get(name);
      if (v) headers.set(name, v);
    }
    headers.set("authorization", `Bearer ${options.apiKey}`);
    const method = req.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();
    const upstream = await fetchImpl(url, { method, headers, body, signal: req.signal });
    const out = new Headers();
    for (const name of ["content-type", "cache-control", "x-oneapi-request-id", "content-disposition"]) {
      const v = upstream.headers.get(name);
      if (v) out.set(name, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** Next.js App Router: `export const { GET, POST, PUT } = createRouteHandler({ apiKey })`. */
export function createRouteHandler(options: ProxyOptions) {
  const handler = createProxy(options);
  return { GET: handler, POST: handler, PUT: handler, DELETE: handler };
}
