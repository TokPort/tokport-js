import type { FetchFunction } from '@ai-sdk/provider-utils';
import {
  convertUint8ArrayToBase64,
  createJsonErrorResponseHandler,
  zodSchema,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';

export const VERSION = '0.1.0';

export type TokPortModelConfig = {
  provider: string;
  baseURL: string;
  headers: () => Record<string, string | undefined>;
  fetch?: FetchFunction;
  /** Used by tests to pin response timestamps. */
  _internal?: { currentDate?: () => Date };
};

/**
 * TokPort returns OpenAI-style errors: `{ error: { message, type?, code? } }`.
 * Some upstream failures carry `code` as a number, so accept both.
 */
const tokportErrorDataSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().nullish(),
    code: z.union([z.string(), z.number()]).nullish(),
  }),
});

export type TokPortErrorData = z.infer<typeof tokportErrorDataSchema>;

export const tokportFailedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: zodSchema(tokportErrorDataSchema),
  errorToMessage: (data) => data.error.message,
  isRetryable: (response) => response.status === 429 || response.status >= 500,
});

type FileLike =
  | { type: 'file'; mediaType: string; data: string | Uint8Array }
  | { type: 'url'; url: string; mediaType?: string };

/**
 * TokPort takes image inputs as a public URL or a `data:` URL in the JSON body.
 */
export function fileToImageReference(file: FileLike): string {
  if (file.type === 'url') return file.url;
  const base64 =
    typeof file.data === 'string' ? file.data : convertUint8ArrayToBase64(file.data);
  return `data:${file.mediaType || 'image/png'};base64,${base64}`;
}

/** Provider options are read from `providerOptions.tokport`. */
export function getTokPortOptions(
  providerOptions: Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown> {
  return { ...(providerOptions?.tokport ?? {}) };
}
