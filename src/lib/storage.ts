import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Where the app keeps files it creates (downloaded instruments now; other data later).
// With S3_BUCKET set, files go to S3, which works on serverless hosts. Otherwise they go to
// DATA_DIR (default ./data), which needs a writable disk.
//
// S3 settings use S3_* names, not AWS_*, because Vercel reserves the AWS_* variables.

export interface FileStore {
  /** Where files go, for display: "s3://bucket/prefix/" or a folder path. */
  location: string;
  /** The file's bytes, or null if there's no such file. */
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
}

// turbopackIgnore: this folder holds runtime data, not code, so the build mustn't trace into it.
export const DATA_DIR = path.resolve(
  /*turbopackIgnore: true*/ process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data"),
);

function checkKey(key: string) {
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(key) || key.split("/").includes("..")) {
    throw new Error(`Invalid storage key: ${key}`);
  }
}

function s3Store(bucket: string): FileStore {
  const prefix = (process.env.S3_PREFIX?.trim() ?? "option-trader/").replace(/^\/+/, "");
  const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const client = new S3Client({
    region: process.env.S3_REGION?.trim() || "ap-south-1",
    // S3-compatible services (Cloudflare R2, MinIO) need their endpoint and path-style URLs.
    endpoint,
    forcePathStyle: Boolean(endpoint),
    // Those services don't support all of the SDK's default checksums; send them only when required.
    ...(endpoint && {
      requestChecksumCalculation: "WHEN_REQUIRED" as const,
      responseChecksumValidation: "WHEN_REQUIRED" as const,
    }),
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  });

  return {
    location: `s3://${bucket}/${prefix}`,
    async get(key) {
      checkKey(key);
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + key }));
        return object.Body ? await object.Body.transformToByteArray() : new Uint8Array();
      } catch (error) {
        if (error instanceof NoSuchKey) return null;
        throw error;
      }
    },
    async put(key, body, contentType) {
      checkKey(key);
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: prefix + key, Body: body, ContentType: contentType }));
    },
  };
}

function diskStore(root: string): FileStore {
  const fileFor = (key: string) => {
    checkKey(key);
    return path.join(root, ...key.split("/"));
  };

  return {
    location: root,
    async get(key) {
      try {
        return new Uint8Array(await readFile(fileFor(key)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async put(key, body) {
      const file = fileFor(key);
      await ensureDir(path.dirname(file));
      // Write then rename, so a reader never sees a half-written file.
      await writeFile(`${file}.tmp`, body);
      await rename(`${file}.tmp`, file);
    },
  };
}

async function ensureDir(dir: string) {
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EROFS" || code === "ENOENT" || code === "EACCES" || code === "EPERM") {
      throw new Error(
        `Can't write to ${dir} (${code}). On a serverless host such as Vercel, set S3_BUCKET (and the ` +
          "other S3_* settings in .env.example) so files go to S3. On a server, set DATA_DIR to a writable folder.",
        { cause: error },
      );
    }
    throw error;
  }
}

// Rebuilt when S3_BUCKET changes, e.g. after editing .env.local while `next dev` runs.
let cached: { bucket: string | undefined; store: FileStore } | undefined;

export function getFileStore(): FileStore {
  const bucket = process.env.S3_BUCKET?.trim() || undefined;
  if (cached?.bucket !== bucket || !cached) {
    cached = { bucket, store: bucket ? s3Store(bucket) : diskStore(DATA_DIR) };
  }
  return cached.store;
}
