-- Share-as-QR: short-lived, single-use tokens that let someone without a device
-- token download one item's original (GET /s/<token>).
--
-- Stored as a SHA-256 like device tokens and enroll codes, so a leaked database
-- can't be replayed during a token's validity window. Not synced: tokens are
-- server-side bookkeeping, and they're pruned soon after they expire.

CREATE TABLE share_tokens (
  token_hash   bytea PRIMARY KEY,
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id      uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  device_id    uuid REFERENCES devices(id) ON DELETE SET NULL,  -- which device showed the code
  expires_at   timestamptz NOT NULL,
  redeemed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX share_tokens_expires_idx ON share_tokens (expires_at);
