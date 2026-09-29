import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from './config.ts';

/**
 * Two clients on purpose.
 *
 * `internal` talks to Garage over the container network for server-side work
 * (HEAD, stat, delete). `presigner` signs URLs against the PUBLIC origin,
 * because the signature covers the Host header and the phone will send whatever
 * host it dialled. Sign with the internal name and every upload dies with
 * SignatureDoesNotMatch — the single most common self-hosted S3 bug.
 *
 * The presigner also opts out of the SDK's default flexible checksums. With them
 * on, a presigned PUT carries `x-amz-checksum-crc32` computed at signing time —
 * i.e. over an EMPTY body — and Garage (correctly) rejects every real upload with
 * InvalidDigest. Integrity comes from `presignPut` instead, which signs the
 * checksum the client *declared*.
 */
export function createS3(config: Config) {
  const common = {
    region: config.S3_REGION,
    forcePathStyle: true, // Garage: no root_domain, so no bucket-as-subdomain
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
  };

  return {
    internal: new S3Client({ ...common, endpoint: config.S3_ENDPOINT }),
    presigner: new S3Client({
      ...common,
      endpoint: config.S3_PUBLIC_ENDPOINT,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    }),
    bucket: config.S3_BUCKET,
  };
}

export type Storage = ReturnType<typeof createS3>;

/** blobs/<ab>/<cd>/<full hex> — two levels of fan-out keeps any prefix listing sane. */
export function storageKey(sha256Hex: string): string {
  return `blobs/${sha256Hex.slice(0, 2)}/${sha256Hex.slice(2, 4)}/${sha256Hex}`;
}

/**
 * A presigned PUT that Garage will only accept for exactly these bytes.
 *
 * Both the length and the SHA-256 are signed into the URL (the checksum rides in
 * the query string, so the client sends no extra headers). Wrong bytes fail with
 * InvalidDigest, a wrong length with a signature mismatch — so the object at a
 * content-addressed key can never hold content other than its name says.
 * Verified against Garage v2.4; the client must send a real Content-Length, not
 * chunked transfer encoding.
 */
export async function presignPut(
  s3: Storage,
  key: string,
  sha256Hex: string,
  byteSize: number,
  expiresIn: number,
): Promise<string> {
  return getSignedUrl(
    s3.presigner,
    new PutObjectCommand({
      Bucket: s3.bucket,
      Key: key,
      ContentLength: byteSize,
      ChecksumSHA256: Buffer.from(sha256Hex, 'hex').toString('base64'),
    }),
    { expiresIn },
  );
}

/**
 * Short-lived GET for an original. The stored content type is whatever the
 * client sent, so override it; `contentDisposition` (e.g. `attachment;
 * filename=…`) is signed into the URL the same way.
 */
export async function presignGet(
  s3: Storage,
  key: string,
  mimeType: string,
  expiresIn: number,
  contentDisposition?: string,
): Promise<string> {
  return getSignedUrl(
    s3.presigner,
    new GetObjectCommand({
      Bucket: s3.bucket,
      Key: key,
      ResponseContentType: mimeType,
      ResponseContentDisposition: contentDisposition,
    }),
    { expiresIn },
  );
}

/** Size and SHA-256 (hex, when Garage has one) of a stored object, or null if absent. */
export async function statObject(
  s3: Storage,
  key: string,
): Promise<{ byteSize: number; sha256Hex: string | null } | null> {
  try {
    const head = await s3.internal.send(
      new HeadObjectCommand({ Bucket: s3.bucket, Key: key, ChecksumMode: 'ENABLED' }),
    );
    return {
      byteSize: head.ContentLength ?? -1,
      sha256Hex: head.ChecksumSHA256 ? Buffer.from(head.ChecksumSHA256, 'base64').toString('hex') : null,
    };
  } catch (err) {
    if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}
