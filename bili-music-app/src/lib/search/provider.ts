import { bilibiliProvider } from "./bilibiliProvider";
import { kernelProvider } from "./kernelProvider";
import { mockProvider } from "./mockProvider";
import type { SearchProvider } from "./types";

export function getSearchProvider(providerOverride?: string): SearchProvider {
  const provider = (providerOverride || process.env.SEARCH_PROVIDER || "bilibili").toLowerCase();
  if (provider === "kernel") {
    return kernelProvider;
  }
  if (provider === "mock") {
    return mockProvider;
  }
  if (provider === "bilibili") {
    return bilibiliProvider;
  }
  return bilibiliProvider;
}

export function providerMode(): string {
  return getSearchProvider().name;
}
