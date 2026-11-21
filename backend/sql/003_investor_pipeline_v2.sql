-- Investor pipeline, Nov 2026 model (generated from MIGRATION_V2 in src/investors.ts; keep in step).
-- The API applies this idempotently on first use, under an advisory lock. Schema only: no investor records.
ALTER TABLE data_room_investors ADD COLUMN IF NOT EXISTS organisation TEXT;
ALTER TABLE data_room_investors ADD COLUMN IF NOT EXISTS last_touch_by TEXT;
ALTER TABLE data_room_investors ADD COLUMN IF NOT EXISTS hook TEXT;
ALTER TABLE data_room_investors ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE data_room_investors ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE data_room_investors ALTER COLUMN status SET DEFAULT 'Intro pending';
ALTER TABLE data_room_investor_activity ADD COLUMN IF NOT EXISTS direction TEXT;
ALTER TABLE data_room_investor_activity ADD COLUMN IF NOT EXISTS link TEXT;

-- Old stage names → new ones. "Waiting reply" with the deck already sent becomes "Deck sent";
-- "Do not contact" becomes Banned and keeps a do-not-contact tag. Each move is recorded.
WITH moved AS (
  SELECT id, status AS old_status,
    CASE WHEN lower(status) = 'waiting reply' AND deck_sent = 'Yes' THEN 'Deck sent' ELSE CASE lower(status) WHEN 'not started' THEN 'Intro pending' WHEN 'drafted' THEN 'Intro pending' WHEN 'check' THEN 'Intro pending' WHEN 'intro requested' THEN 'Intro pending' WHEN 'waiting reply' THEN 'Contacted' WHEN 'due diligence' THEN 'Diligence' WHEN 'term sheet' THEN 'Committed' WHEN 'closed won' THEN 'Closed' WHEN 'watch' THEN 'Reconnect later' WHEN 'on hold' THEN 'Reconnect later' WHEN 'do not contact' THEN 'Banned' END END AS new_status
  FROM data_room_investors WHERE lower(status) IN ('not started','drafted','check','intro requested','waiting reply','due diligence','term sheet','closed won','watch','on hold','do not contact')
), logged AS (
  INSERT INTO data_room_investor_activity (investor_id, kind, summary, actor_subject)
  SELECT id, 'change', 'Stage: ' || old_status || ' → ' || new_status || ' (new stage list, Nov 2026)', 'system:migration' FROM moved
)
UPDATE data_room_investors i SET status = moved.new_status,
  tags = CASE WHEN lower(moved.old_status) = 'do not contact' AND NOT ('do-not-contact' = ANY(i.tags)) THEN i.tags || ARRAY['do-not-contact'] ELSE i.tags END,
  updated_at = now()
FROM moved WHERE i.id = moved.id;

-- Round is now pre-seed-750k (default) or bridge-100k. Free-text values move into notes.
UPDATE data_room_investors SET
  notes = CASE WHEN round IS NOT NULL AND btrim(round) <> '' THEN concat_ws(E'\n', notes, 'Round (before Nov 2026): ' || round) ELSE notes END,
  round = 'pre-seed-750k'
WHERE round IS NULL OR round NOT IN ('pre-seed-750k', 'bridge-100k');

-- Email is unique when present. Skipped (not fatal) if existing rows already share one;
-- the API still refuses new duplicates.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS data_room_investors_email_uq ON data_room_investors (lower(email)) WHERE email IS NOT NULL;
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'duplicate investor emails: unique index not created';
END $$;

-- Audit events are append-only.
CREATE OR REPLACE FUNCTION data_room_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'data_room_audit_events is append-only'; END $fn$;
DROP TRIGGER IF EXISTS data_room_audit_append_only ON data_room_audit_events;
CREATE TRIGGER data_room_audit_append_only BEFORE UPDATE OR DELETE ON data_room_audit_events
  FOR EACH ROW EXECUTE FUNCTION data_room_audit_append_only();

CREATE TABLE IF NOT EXISTS data_room_rate_limits (
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
