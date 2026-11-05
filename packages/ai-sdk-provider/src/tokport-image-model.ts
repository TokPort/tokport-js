import type { ImageModelV4, SharedV4Warning } from '@ai-sdk/provider';
import { InvalidResponseDataError } from '@ai-sdk/provider';
import {
  combineHeaders,
  convertBase64ToUint8Array,
  createBinaryResponseHandler,
  createJsonResponseHandler,
  createStatusCodeErrorResponseHandler,
  getFromApi,
  postJsonToApi,
  zodSchema,
} from '@ai-sdk/provider-utils';
import { z } from 'zod/v4';
import { TOKPORT_IMAGE_EDIT_MODEL_IDS, type TokPortImageModelId } from './model-ids.js';
import {
  fileToImageReference,
  getTokPortOptions,
  tokportFailedResponseHandler,
  type TokPortModelConfig,
} from './shared.js';

type ImageCallOptions = Parameters<ImageModelV4['doGenerate']>[0];
type ImageResult = Awaited<ReturnType<ImageModelV4['doGenerate']>>;

const imageResponseSchema = z.object({
  created: z.number().nullish(),
  data: z.array(
    z
      .object({
        url: z.string().nullish(),
        b64_json: z.string().nullish(),
        revised_prompt: z.string().nullish(),
      })
      .refine((image) => image.url != null || image.b64_json != null, {
        message: 'Expected url or b64_json in the image response',
      }),
  ),
  usage: z
    .object({
      input_tokens: z.number().nullish(),
      output_tokens: z.number().nullish(),
      total_tokens: z.number().nullish(),
    })
    .nullish(),
});

type ImageResponse = z.infer<typeof imageResponseSchema>;

const EDIT_MODELS: ReadonlySet<string> = new Set(TOKPORT_IMAGE_EDIT_MODEL_IDS);

/**
 * Image model for TokPort's OpenAI-compatible images API:
 * `POST /v1/images/generations` (text to image) and `POST /v1/images/edits`
 * (image to image, with the reference image as a URL or `data:` URL in JSON).
 */
export class TokPortImageModel implements ImageModelV4 {
  readonly specificationVersion = 'v4';
  readonly maxImagesPerCall = 4;
  readonly supportsFileInputs: boolean | undefined;
  readonly supportsMaskInputs = undefined;

  get provider(): string {
    return this.config.provider;
  }

  constructor(
    readonly modelId: TokPortImageModelId,
    private readonly config: TokPortModelConfig,
  ) {
    this.supportsFileInputs = EDIT_MODELS.has(modelId) ? true : undefined;
  }

  async doGenerate({
    prompt,
    n,
    size,
    aspectRatio,
    seed,
    files,
    mask,
    providerOptions,
    headers,
    abortSignal,
  }: ImageCallOptions): Promise<ImageResult> {
    const warnings: SharedV4Warning[] = [];
    if (aspectRatio != null) {
      warnings.push({
        type: 'unsupported',
        feature: 'aspectRatio',
        details: 'TokPort image models take `size` ("WIDTHxHEIGHT"), not an aspect ratio.',
      });
    }
    if (seed != null) {
      warnings.push({ type: 'unsupported', feature: 'seed' });
    }

    const currentDate = this.config._internal?.currentDate?.() ?? new Date();
    const isEdit = files != null && files.length > 0;
    const url = `${this.config.baseURL}${isEdit ? '/images/edits' : '/images/generations'}`;
    const requestHeaders = combineHeaders(this.config.headers(), headers);

    const body: Record<string, unknown> = {
      model: this.modelId,
      prompt,
      n,
      ...(size != null ? { size } : {}),
      ...(isEdit
        ? {
            image:
              files.length === 1
                ? fileToImageReference(files[0]!)
                : files.map((file) => fileToImageReference(file)),
          }
        : {}),
      ...(mask != null ? { mask: fileToImageReference(mask) } : {}),
      ...getTokPortOptions(providerOptions),
    };

    const { value: response, responseHeaders } = await postJsonToApi({
      url,
      headers: requestHeaders,
      body,
      failedResponseHandler: tokportFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(zodSchema(imageResponseSchema)),
      abortSignal,
      fetch: this.config.fetch,
    });

    return {
      images: await this.getImages(response.data, { requestUrl: url, abortSignal }),
      warnings,
      providerMetadata: {
        tokport: {
          images: response.data.map((image) => ({
            ...(image.url != null ? { url: image.url } : {}),
            ...(image.revised_prompt != null ? { revisedPrompt: image.revised_prompt } : {}),
          })),
        },
      },
      usage:
        response.usage == null
          ? undefined
          : {
              inputTokens: response.usage.input_tokens ?? undefined,
              outputTokens: response.usage.output_tokens ?? undefined,
              totalTokens: response.usage.total_tokens ?? undefined,
            },
      response: { timestamp: currentDate, modelId: this.modelId, headers: responseHeaders },
    };
  }

  /**
   * The spec wants base64 strings or bytes. b64_json is passed through as is;
   * hosted URLs (the default `response_format`) are downloaded. The download
   * URL comes from the response body, so it is validated and the API key is
   * only sent when it shares the API's origin.
   */
  private async getImages(
    data: ImageResponse['data'],
    { requestUrl, abortSignal }: { requestUrl: string; abortSignal?: AbortSignal },
  ): Promise<string[] | Uint8Array[]> {
    if (data.every((image) => image.b64_json != null)) {
      return data.map((image) => image.b64_json!);
    }
    return Promise.all(
      data.map(async (image) => {
        if (image.b64_json != null) return convertBase64ToUint8Array(image.b64_json);
        if (image.url == null) {
          throw new InvalidResponseDataError({ data: image, message: 'Expected url in the image response' });
        }
        const { value } = await getFromApi({
          url: image.url,
          validateUrl: true,
          trustedOrigin: requestUrl,
          credentialedOrigin: requestUrl,
          headers: this.config.headers(),
          abortSignal,
          fetch: this.config.fetch,
          successfulResponseHandler: createBinaryResponseHandler(),
          failedResponseHandler: createStatusCodeErrorResponseHandler(),
        });
        return value;
      }),
    );
  }
}
