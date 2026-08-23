CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS data_room_documents (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  tier SMALLINT NOT NULL CHECK (tier BETWEEN 1 AND 3),
  description TEXT,
  source TEXT NOT NULL CHECK (source IN ('upload', 'link')),
  link TEXT,
  storage_key TEXT,
  file_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  owner_subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'approved', 'superseded', 'withdrawn')),
  versions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK ((source = 'upload' AND storage_key IS NOT NULL) OR (source = 'link' AND link IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS data_room_documents_visibility_idx ON data_room_documents (status, tier, updated_at DESC);

CREATE TABLE IF NOT EXISTS data_room_access_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_subject TEXT NOT NULL,
  investor_email TEXT NOT NULL,
  firm_name TEXT,
  clearance_tier SMALLINT NOT NULL CHECK (clearance_tier BETWEEN 1 AND 3),
  nda_version TEXT NOT NULL,
  nda_acknowledged_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by_subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (investor_subject)
);

CREATE INDEX IF NOT EXISTS data_room_access_active_idx ON data_room_access_grants (investor_subject, expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS data_room_audit_events (
  event_id UUID PRIMARY KEY,
  event TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  actor_email TEXT,
  document_id UUID,
  detail TEXT,
  ip INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS data_room_audit_time_idx ON data_room_audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS data_room_audit_actor_idx ON data_room_audit_events (actor_subject, created_at DESC);

CREATE TABLE IF NOT EXISTS data_room_upload_intents (
  id UUID PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  owner_subject TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content_length BIGINT NOT NULL CHECK (content_length > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
