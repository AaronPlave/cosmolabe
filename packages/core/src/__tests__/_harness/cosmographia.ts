/**
 * Locating Cosmographia's catalog data, which two suites read as third-party
 * fixtures — one to prove our loader accepts real Cosmographia catalogs, one to
 * parse a real `.xyzv` trajectory.
 *
 * The data is fetched, never vendored: `scripts/fetch-cosmographia-data.sh`
 * sparse-clones ~9 MB of it into a git-ignored `.cosmographia/`. Cosmographia's
 * repository carries no LICENSE file and no license statement in its README, so
 * committing its data into this Apache-2.0 repo would be a rights question we
 * have no answer to. Downloading it at test time is not, and it costs no
 * git-lfs bandwidth either.
 *
 * These suites previously hardcoded `/Users/aplave/code/cosmographia`, so they
 * failed on every machine but one — and `catalog-all-cosmographia` failed at
 * *import*, taking its whole file down rather than reporting a skip.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Where the fetch script puts it, relative to the repo root. */
const FETCHED = join(__dirname, '../../../../../.cosmographia/data');

/**
 * Cosmographia's `data` directory, or `undefined` when it has not been fetched.
 *
 * `COSMOGRAPHIA_DATA` overrides, so a contributor who already has a
 * Cosmographia checkout can point at it instead of fetching a second copy.
 *
 * Returning `undefined` rather than throwing lets a suite skip cleanly on a
 * machine that has not run the fetch. That is not a quarantined failure: CI
 * runs the fetch, so these tests execute there on every pull request — the skip
 * exists so a contributor who has not run one script is not blocked, not to
 * hide a red test.
 */
export function cosmographiaData(): string | undefined {
  const override = process.env.COSMOGRAPHIA_DATA;
  if (override) return existsSync(override) ? override : undefined;
  return existsSync(FETCHED) ? FETCHED : undefined;
}

/** Message naming the one command that makes a skipped suite run. */
export const COSMOGRAPHIA_HINT =
  'Cosmographia data not present — run `bash scripts/fetch-cosmographia-data.sh` ' +
  '(or set COSMOGRAPHIA_DATA to an existing checkout).';
