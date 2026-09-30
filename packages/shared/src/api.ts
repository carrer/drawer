import { z } from 'zod';
import { BlobSchema, CategorySchema, ItemSchema, Sha256Hex, Uuid } from './schema.ts';

/**
 * Delta sync. `since` and `cursor` are values of a Postgres sequence, never
 * timestamps — two rows written in the same millisecond would straddle a
 * wall-clock cursor and one would be silently skipped forever.
 */
export const SyncQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export type SyncQuery = z.infer<typeof SyncQuerySchema>;

export const SyncResponseSchema = z.object({
  items: z.array(ItemSchema),
  categories: z.array(CategorySchema),
  cursor: z.number().int().nonnegative(),
  more: z.boolean(),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

/**
 * Ask for somewhere to put bytes. When the server already holds this sha256 it
 * answers `exists` and the client skips the upload entirely — re-sharing a meme
 * you already saved costs zero bytes.
 */
export const PresignRequestSchema = z.object({
  sha256: Sha256Hex,
  byteSize: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  mimeType: z.string().min(1).max(255),
});
export type PresignRequest = z.infer<typeof PresignRequestSchema>;

export const PresignResponseSchema = z.discriminatedUnion('exists', [
  z.object({ exists: z.literal(true), blobId: Uuid }),
  z.object({
    exists: z.literal(false),
    blobId: Uuid,
    uploadUrl: z.string().url(),
    expiresAt: z.string().datetime({ offset: true }),
  }),
]);
export type PresignResponse = z.infer<typeof PresignResponseSchema>;

/**
 * After the PUT succeeds, the client commits. The server checks the object is
 * really in storage with the declared size before marking the blob uploaded;
 * committing an already-committed blob just returns it again.
 */
export const CommitResponseSchema = BlobSchema;
export type CommitResponse = z.infer<typeof CommitResponseSchema>;

/** Short-lived GET for an item's original bytes. Ask again rather than caching it. */
export const ItemUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime({ offset: true }),
});
export type ItemUrlResponse = z.infer<typeof ItemUrlResponseSchema>;

/**
 * A single-use link to one item's original, for showing as a QR code. Anyone
 * holding `url` can download the file once, until `expiresAt`, with no device
 * token. `ttlSeconds` lets the client count down on its own clock rather than
 * trusting that it agrees with the server's.
 */
export const ShareResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime({ offset: true }),
  ttlSeconds: z.number().int().positive(),
});
export type ShareResponse = z.infer<typeof ShareResponseSchema>;

/** Every word in `q` is matched as a prefix, all must match; results are best-first. */
export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(256),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchResponseSchema = z.object({ items: z.array(ItemSchema) });
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const EnrollRequestSchema = z.object({
  code: z.string().min(8).max(128),
  deviceName: z.string().min(1).max(128),
});
export const EnrollResponseSchema = z.object({
  deviceId: Uuid,
  token: z.string().min(32),
  ownerId: Uuid,
});

/**
 * Google sign-in. The app first asks for a single-use nonce, passes it to
 * Google's sign-in, and sends back the ID token Google signed it into; the
 * server answers exactly like enrollment, with a device token.
 */
/**
 * Public, fetched before sign-in: what this drawer supports. The Web client ID
 * isn't a secret (it's in every ID token's `aud`), so the app learns it from the
 * box it's connecting to rather than having it built in.
 */
export const AuthConfigResponseSchema = z.object({
  googleWebClientId: z.string().nullable(),
});
export type AuthConfigResponse = z.infer<typeof AuthConfigResponseSchema>;

export const NonceResponseSchema = z.object({
  nonce: z.string().min(16),
  expiresAt: z.string().datetime({ offset: true }),
});
export type NonceResponse = z.infer<typeof NonceResponseSchema>;

export const GoogleSignInRequestSchema = z.object({
  idToken: z.string().min(1).max(8192),
  deviceName: z.string().min(1).max(128),
});
export type GoogleSignInRequest = z.infer<typeof GoogleSignInRequestSchema>;

export const WhoAmIResponseSchema = z.object({
  deviceId: Uuid,
  ownerId: Uuid,
  deviceName: z.string(),
  email: z.string().nullable(),
});
export type WhoAmIResponse = z.infer<typeof WhoAmIResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});
