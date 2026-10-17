// Types for the parts of datasets.mjs the viewer's vite.config.ts imports.
export interface Dataset {
  kind: 'terrain' | 'kernels' | 'cube-terrain' | 'cube-imagery';
  name: string;
  localDir: string;
  catalogPrefix: string;
  recursive?: boolean;
  fetchScripts?: string[];
  derivedKernels?: Record<string, { sourceUrls: string[]; scripts: string[] }>;
  attribution?: string;
  build: string | null;
}
export function loadDatasets(path?: string): { version: number; datasets: Record<string, Dataset> };
