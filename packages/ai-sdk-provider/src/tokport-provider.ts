import { NoSuchModelError, type ImageModelV4, type ProviderV4 } from '@ai-sdk/provider';
import {
  loadApiKey,
  withUserAgentSuffix,
  withoutTrailingSlash,
  type FetchFunction,
} from '@ai-sdk/provider-utils';
import type { TokPortImageModelId, TokPortVideoModelId } from './model-ids.js';
import { VERSION, type TokPortModelConfig } from './shared.js';
import { TokPortImageModel } from './tokport-image-model.js';
import { TokPortVideoModel, type TokPortVideoModelSettings } from './tokport-video-model.js';

export const DEFAULT_BASE_URL = 'https://api.tokport.io/v1';

export interface TokPortProviderSettings {
  /**
   * TokPort API key. Defaults to the `TOKPORT_API_KEY` environment variable.
   */
  apiKey?: string;
  /**
   * Base URL of the API, including the `/v1` prefix.
   * Default: `https://api.tokport.io/v1`.
   */
  baseURL?: string;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Custom fetch implementation, e.g. for testing or proxies. */
  fetch?: FetchFunction;
  /** Default polling settings for every video model of this provider. */
  video?: TokPortVideoModelSettings;
}

export interface TokPortProvider extends ProviderV4 {
  /** Image model (text to image, or image to image when `files` are given). */
  image(modelId: TokPortImageModelId): ImageModelV4;
  /** Image model (text to image, or image to image when `files` are given). */
  imageModel(modelId: TokPortImageModelId): ImageModelV4;
  /** Async video model for `experimental_generateVideo`. */
  video(modelId: TokPortVideoModelId, settings?: TokPortVideoModelSettings): TokPortVideoModel;
  /** Async video model for `experimental_generateVideo`. */
  videoModel(modelId: TokPortVideoModelId, settings?: TokPortVideoModelSettings): TokPortVideoModel;
}

/**
 * Create a TokPort provider instance.
 */
export function createTokPort(options: TokPortProviderSettings = {}): TokPortProvider {
  const baseURL = withoutTrailingSlash(options.baseURL) ?? DEFAULT_BASE_URL;

  const getHeaders = () =>
    withUserAgentSuffix(
      {
        Authorization: `Bearer ${loadApiKey({
          apiKey: options.apiKey,
          environmentVariableName: 'TOKPORT_API_KEY',
          description: 'TokPort',
        })}`,
        ...options.headers,
      },
      `ai-sdk/tokport/${VERSION}`,
    );

  const config = (kind: 'image' | 'video'): TokPortModelConfig => ({
    provider: `tokport.${kind}`,
    baseURL,
    headers: getHeaders,
    fetch: options.fetch,
  });

  const createImageModel = (modelId: TokPortImageModelId) =>
    new TokPortImageModel(modelId, config('image'));

  const createVideoModel = (modelId: TokPortVideoModelId, settings: TokPortVideoModelSettings = {}) =>
    new TokPortVideoModel(modelId, { ...options.video, ...settings }, config('video'));

  return {
    specificationVersion: 'v4',
    image: createImageModel,
    imageModel: createImageModel,
    video: createVideoModel,
    videoModel: createVideoModel,
    languageModel: (modelId: string) => {
      throw new NoSuchModelError({
        modelId,
        modelType: 'languageModel',
        message: 'TokPort serves image and video models only.',
      });
    },
    embeddingModel: (modelId: string) => {
      throw new NoSuchModelError({
        modelId,
        modelType: 'embeddingModel',
        message: 'TokPort serves image and video models only.',
      });
    },
  };
}

/**
 * Default TokPort provider instance. Reads the API key from `TOKPORT_API_KEY`.
 */
export const tokport = createTokPort();
