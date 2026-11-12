-- Private investor pipeline (Founder and Investor Relations only).
-- Schema only: investor records are imported in the app, never committed to git.
-- The API also applies this idempotently on first use (see src/investors.ts).

CREATE TABLE IF NOT EXISTS data_room_investors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref TEXT UNIQUE,
  name TEXT NOT NULL,
  type TEXT,
  stage_focus TEXT,
  sector_focus TEXT,
  geography TEXT,
  website TEXT,
  contact_name TEXT,
  contact_title TEXT,
  email TEXT,
  phone TEXT,
  linkedin TEXT,
  warm_intro_source TEXT,
  owner TEXT,
  fund_size_m NUMERIC,
  typical_check_k NUMERIC,
  status TEXT NOT NULL DEFAULT 'Prospect Identified',
  priority TEXT,
  last_contact DATE,
  next_action TEXT,
  next_follow_up DATE,
  interest TEXT,
  round TEXT,
  amount_target_k NUMERIC,
  data_room_shared TEXT,
  deck_sent TEXT,
  nda_signed TEXT,
  meeting_1 DATE,
  meeting_2 DATE,
  due_diligence TEXT,
  decision TEXT,
  probability SMALLINT CHECK (probability BETWEEN 0 AND 100),
  expected_close DATE,
  notes TEXT,
  intro_angle TEXT,
  created_by_subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_room_investor_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id UUID NOT NULL REFERENCES data_room_investors(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  actor_email TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_room_investor_activity_idx ON data_room_investor_activity (investor_id, occurred_at DESC);
