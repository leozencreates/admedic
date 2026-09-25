import { loadEnv } from "@admedic/config";

import { MetaMarketingClient } from "./client";
import { MockMetaClient } from "./mock";

export * from "./client";
export * from "./mock";
export * from "./http";
export * from "./parse";
export * from "./token";
export * from "./capi";
export * from "./types";

export interface MetaClientFactoryOptions {
  /** META_MOCK_MODE override'si (test için). */
  mock?: boolean;
  version?: string;
  fetchFn?: typeof fetch;
}

/**
 * Ortama göre istemci üretir: META_MOCK_MODE=true ise deterministik mock,
 * aksi halde gerçek Meta Marketing API istemcisi. Uygulama adı/sürümü kodda
 * sabitlenmez; `META_API_VERSION` ortam değişkeninden okunur.
 */
export function createMetaClient(options: MetaClientFactoryOptions = {}) {
  const env = loadEnv();
  const mock = options.mock ?? env.META_MOCK_MODE;
  const version = options.version ?? env.META_API_VERSION;
  if (mock) {
    return new MockMetaClient({ version });
  }
  return new MetaMarketingClient({ version, fetchFn: options.fetchFn });
}

export type AnyMetaClient = ReturnType<typeof createMetaClient>;
