import type { Dataset } from './datasets.mjs';
export const DEFAULT_DEV_DATA_BASE_URL: string;
export function createDevCatalogResolver(options: {
  datasets: Record<string, Dataset>;
  root?: string;
  cacheDir?: string;
  baseUrl?: string;
  hostedBaseUrl?: string;
  mode?: string;
  log?: (message: string) => void;
}): (json: unknown, catalogRel: string) => Promise<unknown>;

export function validateDevTerrain(dir: string, cacheDir: string): Promise<{ tiles: number; directories: number }>;
