-- Store enrollment codes the way device tokens are stored: as a SHA-256, never
-- the plaintext. A leaked database (or backup) then can't be replayed to enroll
-- a device during a code's validity window.

ALTER TABLE enroll_codes RENAME COLUMN code TO code_hash;
ALTER TABLE enroll_codes
  ALTER COLUMN code_hash TYPE bytea USING sha256(convert_to(code_hash, 'UTF8'));

-- Which device a code enrolled, so `devices` can be traced back to a code.
ALTER TABLE enroll_codes ADD COLUMN device_id uuid REFERENCES devices(id) ON DELETE SET NULL;
