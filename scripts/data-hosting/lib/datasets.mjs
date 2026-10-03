// Dataset manifest helpers shared by the publisher, the hosted-catalog
// generator and the smoke test (issue #137).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DATASETS_PATH = join(ROOT, 'scripts/data-hosting/datasets.json');
/** Directory the viewer serves as its publicDir; catalog-relative paths resolve inside it. */
export const CATALOG_ROOT = 'apps/viewer/test-catalogs';

const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function loadDatasets(path = DATASETS_PATH) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (doc.version !== 1) throw new Error(`${path}: unsupported version ${doc.version}`);
  return doc;
}

export function saveDatasets(doc, path = DATASETS_PATH) {
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

export function assertBuildId(build) {
  if (typeof build !== 'string' || !BUILD_ID.test(build)) {
    throw new Error(`invalid build id ${JSON.stringify(build)}: use letters, digits, '.', '_' or '-' (max 64)`);
  }
}

/**
 * Remote key prefix (with trailing slash) for a dataset build.
 *   terrain/<name>/<build>/        kernels/<name>-<build>/
 * Builds are immutable; a new build is a new prefix.
 */
export function remotePrefix(dataset, build = dataset.build) {
  assertBuildId(build);
  return dataset.kind === 'kernels'
    ? `kernels/${dataset.name}-${build}/`
    : `${dataset.kind}/${dataset.name}/${build}/`;
}

/** Join a base URL and a key without doubling slashes. */
export function joinUrl(base, key) {
  return `${base.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`;
}
