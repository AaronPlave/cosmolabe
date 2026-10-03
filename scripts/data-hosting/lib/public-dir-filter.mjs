// Which files of the viewer's publicDir a hosted-data build should NOT copy into
// dist/ (issue #137). The published datasets in datasets.json are served from the
// data host, so copying them — gigabytes locally — is wasted work that
// build-hosted-catalogs.mjs would only delete afterwards.
import { statSync } from 'node:fs';
import { posix, relative, sep } from 'node:path';

/** Returns (absolutePath) => boolean: true to copy, false to skip. */
export function publicDirCopyFilter(datasets, publicDir) {
  const hosted = Object.values(datasets).filter((d) => d.build);
  return (abs) => {
    const rel = relative(publicDir, abs).split(sep).join('/');
    if (!rel || rel.startsWith('..')) return true;
    for (const d of hosted) {
      const dir = d.catalogPrefix.replace(/\/$/, '');
      if (d.recursive === false) {
        // Only the files directly inside the directory (e.g. kernels/*.bsp), not
        // its subdirectories, which are datasets of their own.
        if (posix.dirname(rel) === dir && !statSync(abs).isDirectory()) return false;
      } else if (rel === dir || rel.startsWith(`${dir}/`)) {
        return false;
      }
    }
    return true;
  };
}
