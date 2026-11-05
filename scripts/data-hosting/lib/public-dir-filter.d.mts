import type { Dataset } from './datasets.mjs';
export function publicDirCopyFilter(
  datasets: Record<string, Pick<Dataset, 'catalogPrefix' | 'recursive' | 'build' | 'localOnly' | 'catalogs'>>,
  publicDir: string,
  alsoSkip?: string[],
): (absolutePath: string) => boolean;
