import type { Dataset } from './datasets.mjs';
export const DEFAULT_DEV_DATA_BASE_URL: string;
export function createDevCatalogResolver(options: {
  datasets: Record<string, Dataset>;
  root?: string;
  baseUrl?: string;
  mode?: string;
  log?: (message: string) => void;
}): (json: unknown, catalogRel: string) => Promise<unknown>;
