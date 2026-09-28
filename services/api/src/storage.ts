import { S3Client } from '@aws-sdk/client-s3';
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
 * InvalidDigest. Integrity is already covered: the key is the content's SHA-256.
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
