// Pinned SPICE kernel sets: provenance, header validation and manifest (issue #137).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createGunzip } from 'node:zlib';

const TYPES = {
  bsp: 'SPK', bc: 'CK', bpc: 'PCK', bds: 'DSK', bes: 'EK',
  tpc: 'PCK', tf: 'FK', ti: 'IK', tls: 'LSK', tsc: 'SCLK', tm: 'META',
};

const stripGz = (name) => name.replace(/\.gz$/i, '');

export function kernelType(filename) {
  const ext = stripGz(filename).split('.').pop().toLowerCase();
  return TYPES[ext] ?? 'UNKNOWN';
}

/** Read the first `n` bytes of a (possibly gzipped) file. */
function head(path, n) {
  return new Promise((resolve, reject) => {
    const src = createReadStream(path);
    const stream = path.toLowerCase().endsWith('.gz') ? src.pipe(createGunzip()) : src;
    const chunks = [];
    let len = 0;
    const finish = () => { src.destroy(); resolve(Buffer.concat(chunks).subarray(0, n)); };
    stream.on('data', (c) => { chunks.push(c); len += c.length; if (len >= n) finish(); });
    stream.on('end', finish);
    stream.on('error', reject);
    src.on('error', reject);
  });
}

/**
 * Cheap sanity check that a file is the kernel its name claims: binary kernels
 * start with a DAF/DAS file record ("DAF/SPK", …); text kernels with "KPL/".
 * Catches an HTML error page or a truncated download saved under a kernel name.
 */
export async function validateKernelHeader(path) {
  const name = stripGz(basename(path));
  const type = kernelType(name);
  const buf = await head(path, 16);
  const text = buf.toString('latin1');
  const binary = /\.(bsp|bc|bpc|bds|bes)$/i.test(name);
  if (binary) {
    // Pre-1990s kernels (e.g. Cassini CKs) carry the legacy "NAIF/DAF" identifier word.
    if (!/^(DAF|DAS)\//.test(text) && !/^NAIF\/DAF/.test(text)) throw new Error(`${basename(path)}: expected a DAF/DAS header, found ${JSON.stringify(text.slice(0, 12))}`);
    if (type !== 'UNKNOWN' && /^DAF\//.test(text)) {
      const kind = text.slice(4, 8).trim();
      const want = { SPK: 'SPK', CK: 'CK', PCK: 'PCK' }[type];
      if (want && kind !== want) throw new Error(`${basename(path)}: header says DAF/${kind} but extension implies ${want}`);
    }
  } else if (/\.(tf|ti|tls|tpc|tsc)$/i.test(name)) {
    if (!/^KPL\//.test(text)) throw new Error(`${basename(path)}: expected a "KPL/" text-kernel header, found ${JSON.stringify(text.slice(0, 12))}`);
  }
}

// ── Upstream URL resolution from the fetch scripts ──────────────────────────
// The fetch scripts are the record of where each kernel comes from. Rather than
// duplicating that in a second table, read their `VAR="https://…"` assignments
// and the lines that name each file.

function parseShell(text) {
  const vars = {};
  const expand = (s) => s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, k) => vars[k] ?? m);
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)="(https?:\/\/[^"]*)"/);
    if (m) vars[m[1]] = expand(m[2]);
  }
  return { vars, expand };
}

/**
 * Best-effort map filename -> upstream URL from one fetch script. Handles the
 * three shapes the scripts use: a full "$BASE/dir/file" URL, a "dir|file" pair
 * fetched as "$BASE/$subdir/$filename", and a "remote|local" pair.
 */
export function upstreamFromScript(text) {
  const { vars, expand } = parseShell(text);
  const out = new Map();
  const lines = text.split('\n');

  // Base used by the loop's `curl … "$NAIF_X/$subdir/$filename"` line.
  let pairBase;
  for (const line of lines) {
    const m = line.match(/curl[^\n]*"(\$\{?[A-Z_]+\}?)\/\$\{?subdir\}?\/\$\{?filename\}?"/);
    if (m) pairBase = expand(m[1]);
  }
  // Base used by `curl … "$BASE/$kernel"` over an array of "dir/file" entries.
  let arrayBase;
  for (const line of lines) {
    const m = line.match(/curl[^\n]*"(\$\{?[A-Z_]+\}?)\/\$\{?kernel\}?"/);
    if (m) arrayBase = expand(m[1]);
  }
  // Base used by `curl … "$BASE/$remote_path" -o "$dest_file"` (clipper-style).
  let remoteBase;
  for (const line of lines) {
    const m = line.match(/curl[^\n]*"(\$\{?[A-Z_]+\}?)\/\$\{?remote_path\}?"/);
    if (m) remoteBase = expand(m[1]);
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '');
    let m = line.match(/"(\$\{?[A-Z_]+\}?\/[^"|]+)"/);
    if (m && /\.[A-Za-z0-9]+(\.gz)?"?$/.test(m[1])) {
      const url = expand(m[1]);
      if (url.startsWith('http')) out.set(basename(url), url);
      continue;
    }
    m = arrayBase && line.match(/^\s*"([a-z]+\/[A-Za-z0-9_/.\-]+)"/);
    if (m) {
      out.set(basename(m[1]), `${arrayBase}/${m[1]}`);
      continue;
    }
    m = line.match(/"([A-Za-z0-9_/.\-]+)\|([A-Za-z0-9_/.\-]+)(?:\|[^"]*)?"/);
    if (m) {
      const [, left, right] = m;
      if (!left.includes('/') && right.includes('/') && remoteBase) {
        // "local_name|remote_path"
        out.set(left, `${remoteBase}/${right}`);
      } else if (left.includes('/') && !right.includes('/') && pairBase === undefined) {
        // "remote_path|local_name": remote path relative to the script's base.
        const base = remoteBase ?? vars.NAIF_GENERIC ?? vars.NAIF;
        if (base) out.set(right, `${base}/${left}`);
      } else if (!left.includes('/') && pairBase) {
        out.set(right, `${pairBase}/${left}/${right}`);
      } else if (left.includes('/') && vars.NAIF_GENERIC) {
        out.set(right, `${vars.NAIF_GENERIC}/${left}`);
      }
    }
  }
  return out;
}

export function resolveUpstream(filename, scriptTexts) {
  const want = stripGz(filename);
  for (const text of scriptTexts) {
    const u = upstreamFromScript(text).get(want);
    if (u) return u;
  }
  return null;
}

function trackedFiles(root, localDir) {
  try {
    const out = execFileSync('git', ['ls-files', '--', localDir], { cwd: root, encoding: 'utf8' });
    return new Set(out.split('\n').filter(Boolean).map((p) => p.slice(localDir.length + 1)));
  } catch {
    return new Set();
  }
}

export async function kernelManifest({
  dataset, build, entries, inventorySha256, srcDir, root, gitCommit, now = new Date(), strictProvenance = false,
}) {
  const scripts = (dataset.fetchScripts ?? []).map((rel) => {
    const text = readFileSync(join(root, rel), 'utf8');
    return { path: rel, text, sha256: createHash('sha256').update(text).digest('hex') };
  });
  const tracked = trackedFiles(root, dataset.localDir);
  const files = entries
    .filter((e) => !['manifest.json', 'inventory.jsonl.gz'].includes(e.path))
    .map((e) => {
      const upstreamUrl = resolveUpstream(e.path, scripts.map((s) => s.text));
      // Small kernels committed to the repository have no fetch
      // line; their provenance is the repository path at the publishing commit.
      const repositoryPath = tracked.has(e.path) ? `${dataset.localDir}/${e.path}` : null;
      if (!upstreamUrl && !repositoryPath && strictProvenance) {
        throw new Error(`no upstream URL found in ${dataset.fetchScripts?.join(', ')} and not tracked in git: ${e.path}`);
      }
      return {
        filename: e.path,
        kernelType: kernelType(e.path),
        gzip: e.path.toLowerCase().endsWith('.gz'),
        sizeBytes: e.size,
        sha256: e.sha256,
        upstreamUrl,
        repositoryPath,
        retrievedAt: statSync(join(srcDir, e.path)).mtime.toISOString(),
      };
    });
  return {
    version: 1,
    kind: 'kernels',
    name: dataset.name,
    build,
    createdAt: now.toISOString(),
    publisher: { tool: 'scripts/publish-data.mjs', gitCommit },
    fetchScripts: scripts.map(({ path, sha256 }) => ({ path, sha256 })),
    attribution: 'SPICE kernels from NASA/JPL NAIF (https://naif.jpl.nasa.gov/naif/). Mirrored unmodified; see upstreamUrl per file.',
    fileCount: files.length,
    totalBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
    inventory: { key: 'inventory.jsonl.gz', sha256: inventorySha256, entries: entries.length },
    files,
  };
}
