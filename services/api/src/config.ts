import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  // Origin that share links (QR codes) point at: the API as a *recipient* can
  // reach it. Tailnet-only today; a public origin (e.g. Funnel) later.
  SHARE_BASE_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, '')),
  // The OAuth *Web* client ID that Google ID tokens are issued for (the app's
  // `serverClientId`). Unset: Google sign-in answers 503 and only operator
  // enrollment codes work. Empty counts as unset (compose passes "" for it).
  GOOGLE_CLIENT_ID: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Fail loudly at boot naming every missing variable, rather than throwing on the
 * first request that happens to need one.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration:\n${problems.join('\n')}`);
  }
  return parsed.data;
}
