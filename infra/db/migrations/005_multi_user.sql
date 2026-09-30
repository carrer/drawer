-- Multiple user accounts, signed in with Google (PLAN.md §5, decided 2026-09-30).
--
-- Every row was already owner-scoped; this closes the three places a second
-- user would collide with or read the first:
--   1. Category ids were global, so only one user could own the well-known Inbox
--      id (INBOX_CATEGORY_ID). They are now unique per owner.
--   2. Blobs were global and content-addressed: anyone who knew a file's SHA-256
--      could attach it to their own item and download it. Each owner now has
--      their own blob rows (and storage keys), and an item can only reference its
--      owner's blobs — enforced by foreign key, not just by the API.
--   3. Users had no identity to sign in with.

-- 1. Users: a Google account (`google_sub`, stable even if the email changes)
-- binds to an invited email on first sign-in. Emails are stored lowercased.
ALTER TABLE users
  ADD COLUMN google_sub   text UNIQUE,
  ADD COLUMN display_name text,
  ADD COLUMN disabled_at  timestamptz,
  ADD CONSTRAINT users_email_lower CHECK (email = lower(email));

-- 2. Categories: primary key (owner_id, id). Membership rows carry the owner so
-- they can reference it, and a composite key on items makes a membership whose
-- item and category belong to different owners impossible.
ALTER TABLE item_categories ADD COLUMN owner_id uuid;
UPDATE item_categories ic SET owner_id = i.owner_id FROM items i WHERE i.id = ic.item_id;
ALTER TABLE item_categories ALTER COLUMN owner_id SET NOT NULL;

ALTER TABLE item_categories
  DROP CONSTRAINT item_categories_category_id_fkey,
  DROP CONSTRAINT item_categories_item_id_fkey;
ALTER TABLE categories DROP CONSTRAINT categories_pkey;
ALTER TABLE categories ADD PRIMARY KEY (owner_id, id);
ALTER TABLE items ADD CONSTRAINT items_id_owner_key UNIQUE (id, owner_id);
ALTER TABLE item_categories
  ADD CONSTRAINT item_categories_item_fkey
    FOREIGN KEY (item_id, owner_id) REFERENCES items (id, owner_id) ON DELETE CASCADE,
  ADD CONSTRAINT item_categories_category_fkey
    FOREIGN KEY (owner_id, category_id) REFERENCES categories (owner_id, id) ON DELETE CASCADE;

DROP INDEX item_categories_cat_idx;
CREATE INDEX item_categories_cat_idx ON item_categories (owner_id, category_id, item_id);

-- 3. Blobs: one row per (owner, sha256). No cross-user dedupe: it would tell one
-- user that another holds a file, and proving you really have the bytes would
-- need a staging upload. Existing blobs all belong to the one user there has
-- been; their storage keys keep the old layout and stay valid (the key is stored
-- per row), while new uploads go under blobs/<owner>/.
ALTER TABLE blobs ADD COLUMN owner_id uuid REFERENCES users(id) ON DELETE CASCADE;
UPDATE blobs b SET owner_id = coalesce(
  (SELECT i.owner_id FROM items i WHERE i.blob_id = b.id OR i.link_image_blob_id = b.id LIMIT 1),
  '00000000-0000-0000-0000-000000000001');
ALTER TABLE blobs ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE blobs DROP CONSTRAINT blobs_sha256_key;
ALTER TABLE blobs
  ADD CONSTRAINT blobs_owner_sha256_key UNIQUE (owner_id, sha256),
  ADD CONSTRAINT blobs_id_owner_key UNIQUE (id, owner_id);

ALTER TABLE items
  DROP CONSTRAINT items_blob_id_fkey,
  DROP CONSTRAINT items_link_image_blob_id_fkey,
  ADD CONSTRAINT items_blob_fkey
    FOREIGN KEY (blob_id, owner_id) REFERENCES blobs (id, owner_id),
  ADD CONSTRAINT items_link_image_blob_fkey
    FOREIGN KEY (link_image_blob_id, owner_id) REFERENCES blobs (id, owner_id);

-- Share tokens name an item; make sure it's the token owner's item.
ALTER TABLE share_tokens
  DROP CONSTRAINT share_tokens_item_id_fkey,
  ADD CONSTRAINT share_tokens_item_fkey
    FOREIGN KEY (item_id, owner_id) REFERENCES items (id, owner_id) ON DELETE CASCADE;

-- Single-use nonces for Google sign-in: the phone asks for one, Google signs it
-- into the ID token, and the exchange consumes it — so a captured ID token
-- can't be replayed for a device token. Hash only, like every other secret.
CREATE TABLE auth_nonces (
  nonce_hash  bytea PRIMARY KEY,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX auth_nonces_expires_idx ON auth_nonces (expires_at);
