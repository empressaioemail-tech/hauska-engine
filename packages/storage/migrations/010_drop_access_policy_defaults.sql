-- 010_drop_access_policy_defaults.sql
--
-- Remove fail-open DEFAULT 'public-free' from access_policy columns so a
-- writer that omits the column errors instead of being silently filled in.
-- NOT NULL is retained; explicit accessPolicy is required on every INSERT.

INSERT INTO schema_migrations (filename)
VALUES ('010_drop_access_policy_defaults.sql')
ON CONFLICT (filename) DO NOTHING;

ALTER TABLE atoms
  ALTER COLUMN access_policy DROP DEFAULT;

ALTER TABLE jurisdiction_status
  ALTER COLUMN access_policy DROP DEFAULT;
