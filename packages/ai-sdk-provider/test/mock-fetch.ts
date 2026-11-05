export type RecordedCall = {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
};

type Responder = (call: RecordedCall) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function bytes(data: Uint8Array, contentType: string): Response {
  return new Response(data as BodyInit, { status: 200, headers: { 'content-type': contentType } });
}

/**
 * A fetch stub routed by "METHOD url". A route may hold a list of responders,
 * consumed in order (the last one repeats).
 */
export function mockFetch(routes: Record<string, Responder | Responder[]>) {
  const calls: RecordedCall[] = [];
  const counters = new Map<string, number>();

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (init?.signal?.aborted) {
      throw init.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call = { method, url, headers: new Headers(init?.headers), body };
    calls.push(call);

    const key = `${method} ${url}`;
    const route = routes[key];
    if (route == null) return new Response(`no mock for ${key}`, { status: 599 });
    if (!Array.isArray(route)) return route(call);
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    return route[Math.min(index, route.length - 1)]!(call);
  };

  return { fetch: fetch as typeof globalThis.fetch, calls };
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
// ftyp box so media type sniffing recognises MP4.
export const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 1, 2, 3, 4]);
