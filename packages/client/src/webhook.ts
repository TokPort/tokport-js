export interface WebhookPayload {
  request_id: string;
  gateway_request_id: string;
  status: "OK" | "ERROR";
  payload?: unknown;
  error?: { message: string; code?: string };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a TokPort webhook (HMAC-SHA256 over `${timestamp}.${rawBody}` with the
 * key's signing secret from the dashboard). Returns the parsed payload or null.
 * Uses WebCrypto, so it runs in Node 18+, Bun, Deno, Workers and browsers.
 */
export async function verifyWebhook(
  rawBody: string,
  headers: Record<string, string | undefined> | Headers,
  secret: string,
  options: { toleranceSec?: number; nowSec?: number } = {},
): Promise<WebhookPayload | null> {
  const get = (name: string) => (headers instanceof Headers ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()]) ?? "";
  const timestamp = get("x-tokport-webhook-timestamp");
  const signature = get("x-tokport-webhook-signature");
  if (!/^\d+$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) return null;
  const now = options.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > (options.toleranceSec ?? 300)) return null;
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  if (!constantTimeEqual(expected, signature.toLowerCase())) return null;
  try {
    return JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return null;
  }
}
