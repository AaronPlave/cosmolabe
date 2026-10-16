// Object-storage backends for the data publisher (issue #137).
//
//   S3 backend    Cloudflare R2 (or any S3-compatible store) via @aws-sdk/client-s3.
//   Local backend a plain directory, used by tests and for dry runs against disk.
//
// Both expose the same four calls, so the publisher never knows which it has.
//   put(key, source, meta)  source = { path, size } | { body: Buffer }; atomic
//   head(key)               -> { size, contentType, contentEncoding, cacheControl } | null
//   list(prefix)            -> Map<key, size>
//   get(key)                -> Buffer | null
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

const MULTIPART_THRESHOLD = 8 * 1024 * 1024;
const PART_SIZE = 16 * 1024 * 1024;

export function createS3Storage({
  accountId = process.env.R2_ACCOUNT_ID,
  accessKeyId = process.env.R2_ACCESS_KEY_ID,
  secretAccessKey = process.env.R2_SECRET_ACCESS_KEY,
  bucket = process.env.R2_BUCKET,
  endpoint = process.env.R2_ENDPOINT,
} = {}) {
  const missing = [
    ['R2_ACCESS_KEY_ID', accessKeyId],
    ['R2_SECRET_ACCESS_KEY', secretAccessKey],
    ['R2_BUCKET', bucket],
    ['R2_ACCOUNT_ID (or R2_ENDPOINT)', accountId ?? endpoint],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`missing R2 credentials: ${missing.join(', ')}`);

  let clientPromise;
  const sdk = () => (clientPromise ??= import('@aws-sdk/client-s3').then((m) => ({
    m,
    client: new m.S3Client({
      region: 'auto',
      endpoint: endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      // R2 rejects the SDK's default flexible-checksum trailers on streamed bodies.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 8,
    }),
  })));

  return {
    name: `r2:${bucket}`,
    async put(key, source, meta) {
      const { m, client } = await sdk();
      const params = {
        Bucket: bucket,
        Key: key,
        ContentType: meta.contentType,
        ContentEncoding: meta.contentEncoding,
        CacheControl: meta.cacheControl,
      };
      // Small objects go up as one buffered PUT: a Buffer can be replayed on retry,
      // a stream cannot. Large files use multipart, so a dropped connection costs
      // one retried part, not the whole file.
      if (source.body || source.size <= MULTIPART_THRESHOLD) {
        const body = source.body ?? await readFile(source.path);
        await client.send(new m.PutObjectCommand({ ...params, Body: body, ContentLength: body.length }));
        return;
      }
      const { Upload } = await import('@aws-sdk/lib-storage');
      await new Upload({
        client,
        params: { ...params, Body: createReadStream(source.path) },
        partSize: PART_SIZE,
        queueSize: 2,
        leavePartsOnError: false,
      }).done();
    },
    async head(key) {
      const { m, client } = await sdk();
      try {
        const r = await client.send(new m.HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          size: r.ContentLength,
          contentType: r.ContentType,
          contentEncoding: r.ContentEncoding,
          cacheControl: r.CacheControl,
        };
      } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
        throw err;
      }
    },
    async list(prefix) {
      const { m, client } = await sdk();
      const out = new Map();
      let token;
      do {
        const r = await client.send(new m.ListObjectsV2Command({
          Bucket: bucket, Prefix: prefix, ContinuationToken: token,
        }));
        for (const o of r.Contents ?? []) out.set(o.Key, o.Size);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async get(key) {
      const { m, client } = await sdk();
      try {
        const r = await client.send(new m.GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await r.Body.transformToByteArray());
      } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') return null;
        throw err;
      }
    },
  };
}

const META_DIR = '.object-meta';

/** Directory-backed store. Object `a/b` lives at <root>/a/b, its headers at <root>/.object-meta/a/b.json. */
export function createLocalStorage(root) {
  const objPath = (key) => join(root, ...key.split('/'));
  const metaPath = (key) => join(root, META_DIR, ...key.split('/')) + '.json';
  return {
    name: `dir:${root}`,
    root,
    async put(key, source, meta) {
      const dest = objPath(key);
      await mkdir(dirname(dest), { recursive: true });
      const tmp = `${dest}.partial-${process.pid}`;
      if (source.body) await writeFile(tmp, source.body);
      else await copyFile(source.path, tmp);
      await rename(tmp, dest);
      await mkdir(dirname(metaPath(key)), { recursive: true });
      await writeFile(metaPath(key), JSON.stringify(meta));
    },
    async head(key) {
      try {
        const st = await stat(objPath(key));
        if (!st.isFile()) return null;
        const meta = JSON.parse(await readFile(metaPath(key), 'utf8').catch(() => '{}'));
        return { size: st.size, ...meta };
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async list(prefix) {
      const out = new Map();
      const walk = async (dir) => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) {
          if (e.code === 'ENOENT') return;
          throw e;
        }
        for (const e of entries) {
          if (dir === root && e.name === META_DIR) continue;
          const p = join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (!e.name.includes('.partial-')) {
            const key = relative(root, p).split(sep).join('/');
            if (key.startsWith(prefix)) out.set(key, (await stat(p)).size);
          }
        }
      };
      await walk(root);
      return out;
    },
    async get(key) {
      try { return await readFile(objPath(key)); } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async remove(key) {
      await rm(objPath(key), { force: true });
      await rm(metaPath(key), { force: true });
    },
  };
}
