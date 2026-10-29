import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Dataset } from './datasets.mjs';
export function hostedAssetUrl(relativePath: string, datasets: Record<string, Dataset>, baseUrl: string): URL | undefined;
export function createDevAssetFallback(options: {
  datasets: Record<string, Dataset>;
  baseUrl?: string;
  mode?: string;
  timeoutMs?: number;
}): (req: IncomingMessage, res: ServerResponse, relativePath: string) => boolean;
