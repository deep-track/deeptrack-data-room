import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { AuditEvent, DataRoomDocument, DocumentStatus, DocumentVersion } from "./types.js";

let pool: Pool | undefined;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server configuration: ${name}`);
  return value;
}

export function getPool() {
  pool ??= new Pool({ connectionString: required("DATABASE_URL"), max: Number(process.env.DB_POOL_MAX || 5), ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  return pool;
}

// Keep in step with sql/001_initial.sql. Every statement is IF NOT EXISTS, so this
// is safe to run against a database that already has the schema.
const BASE_DDL = `
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
`;
let baseSchemaReady: Promise<void> | undefined;
export function ensureBaseSchema() {
  baseSchemaReady ??= getPool().query(BASE_DDL).then(() => undefined).catch((error) => { baseSchemaReady = undefined; throw error; });
  return baseSchemaReady;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  return getPool().query<T>(text, values);
}

function mapDocument(row: Record<string, unknown>): DataRoomDocument {
  return {
    id: String(row.id), title: String(row.title), category: String(row.category), tier: Number(row.tier) as 1 | 2 | 3,
    description: row.description ? String(row.description) : undefined, fileName: row.file_name ? String(row.file_name) : undefined,
    mimeType: row.mime_type ? String(row.mime_type) : undefined, sizeBytes: row.size_bytes ? Number(row.size_bytes) : undefined,
    source: String(row.source) as "upload" | "link", link: row.link ? String(row.link) : undefined,
    storageKey: row.storage_key ? String(row.storage_key) : undefined, status: String(row.status) as DocumentStatus,
    ownerSubject: String(row.owner_subject), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
    versions: Array.isArray(row.versions) ? row.versions as DocumentVersion[] : [],
  };
}

export async function listApprovedDocuments(clearanceTier: number) {
  const result = await query("SELECT id, title, category, tier, description, file_name, mime_type, size_bytes, source, link, storage_key, status, owner_subject, created_at, updated_at, versions FROM data_room_documents WHERE status = 'approved' AND tier <= $1 ORDER BY updated_at DESC", [clearanceTier]);
  return result.rows.map((row) => mapDocument(row));
}

export async function getDocument(id: string) {
  const result = await query("SELECT id, title, category, tier, description, file_name, mime_type, size_bytes, source, link, storage_key, status, owner_subject, created_at, updated_at, versions FROM data_room_documents WHERE id = $1", [id]);
  return result.rows[0] ? mapDocument(result.rows[0]) : undefined;
}

export async function insertDocument(input: { id: string; title: string; category: string; tier: number; description?: string; source: string; link?: string; storageKey?: string; fileName?: string; mimeType?: string; sizeBytes?: number; ownerSubject: string; status: DocumentStatus; version?: string }, executor: { query: PoolClient["query"] } = getPool()) {
  const now = new Date().toISOString();
  const versions = [{ version: input.version || "1.0", createdAt: now, note: "Initial filing" }];
  const result = await executor.query("INSERT INTO data_room_documents (id,title,category,tier,description,source,link,storage_key,file_name,mime_type,size_bytes,owner_subject,status,versions,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$15) RETURNING *", [input.id,input.title,input.category,input.tier,input.description ?? null,input.source,input.link ?? null,input.storageKey ?? null,input.fileName ?? null,input.mimeType ?? null,input.sizeBytes ?? null,input.ownerSubject,input.status,JSON.stringify(versions),now]);
  return mapDocument(result.rows[0]);
}

export async function insertAudit(event: Omit<AuditEvent, "pk" | "sk" | "entityType">) {
  await query("INSERT INTO data_room_audit_events (event_id,event,actor_subject,actor_email,document_id,detail,ip,user_agent,created_at) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8)", [event.event,event.actorSubject,event.actorEmail ?? null,event.documentId ?? null,event.detail ?? null,event.ip ?? null,event.userAgent ?? null,event.createdAt]);
}


export type AccessGrant = {
  id: string;
  investorSubject: string;
  investorEmail: string;
  firmName?: string;
  clearanceTier: 1 | 2 | 3;
  ndaVersion: string;
  ndaAcknowledgedAt?: string;
  expiresAt: string;
  revokedAt?: string;
};

// Invitations are stored against the investor's email (investor_subject = "pending:<email>")
// until that person signs in with the same Auth0-verified email; the grant is then bound to
// their Auth0 subject. Nobody can claim an invitation with an unverified email.
const PENDING = "pending:";
const GRANT_COLUMNS = "id, investor_subject, investor_email, firm_name, clearance_tier, nda_version, nda_acknowledged_at, expires_at, revoked_at";

function mapGrant(row: Record<string, unknown>): AccessGrant {
  return {
    id: String(row.id), investorSubject: String(row.investor_subject), investorEmail: String(row.investor_email),
    firmName: row.firm_name ? String(row.firm_name) : undefined, clearanceTier: Number(row.clearance_tier) as 1 | 2 | 3,
    ndaVersion: String(row.nda_version), ndaAcknowledgedAt: row.nda_acknowledged_at ? new Date(String(row.nda_acknowledged_at)).toISOString() : undefined,
    expiresAt: new Date(String(row.expires_at)).toISOString(), revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : undefined,
  };
}

export async function getActiveGrant(subject: string, verifiedEmail?: string): Promise<AccessGrant | undefined> {
  const result = await query(`SELECT ${GRANT_COLUMNS} FROM data_room_access_grants WHERE investor_subject = $1 AND revoked_at IS NULL AND expires_at > now()`, [subject]);
  if (result.rows[0]) return mapGrant(result.rows[0] as Record<string, unknown>);
  if (!verifiedEmail) return undefined;
  // First sign-in after an invitation: bind the pending invitation to this identity.
  const claimed = await query(`UPDATE data_room_access_grants SET investor_subject = $1 WHERE investor_subject = $2 AND revoked_at IS NULL AND expires_at > now() AND NOT EXISTS (SELECT 1 FROM data_room_access_grants WHERE investor_subject = $1) RETURNING ${GRANT_COLUMNS}`, [subject, PENDING + verifiedEmail.toLowerCase()]);
  return claimed.rows[0] ? mapGrant(claimed.rows[0] as Record<string, unknown>) : undefined;
}

export async function upsertAccessGrant(input: { investorSubject: string; investorEmail: string; firmName?: string; clearanceTier: number; ndaVersion: string; expiresAt: string; createdBySubject: string }) {
  const result = await query(`INSERT INTO data_room_access_grants (investor_subject, investor_email, firm_name, clearance_tier, nda_version, expires_at, created_by_subject) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (investor_subject) DO UPDATE SET investor_email=excluded.investor_email, firm_name=excluded.firm_name, clearance_tier=excluded.clearance_tier, nda_version=excluded.nda_version, expires_at=excluded.expires_at, revoked_at=NULL RETURNING ${GRANT_COLUMNS}`, [input.investorSubject, input.investorEmail, input.firmName ?? null, input.clearanceTier, input.ndaVersion, input.expiresAt, input.createdBySubject]);
  return mapGrant(result.rows[0] as Record<string, unknown>);
}

// Invite (or re-invite) an investor by email. Re-inviting someone who already has a grant
// updates that grant instead of creating a second one.
export async function inviteInvestor(input: { investorEmail: string; firmName?: string; clearanceTier: number; ndaVersion: string; expiresAt: string; createdBySubject: string }) {
  const email = input.investorEmail.trim().toLowerCase();
  const existing = await query("SELECT id, nda_version FROM data_room_access_grants WHERE lower(investor_email) = $1 ORDER BY created_at DESC LIMIT 1", [email]);
  const row = existing.rows[0] as { id: string; nda_version: string } | undefined;
  if (row) {
    const updated = await query(`UPDATE data_room_access_grants SET firm_name=$2, clearance_tier=$3, nda_version=$4, expires_at=$5, revoked_at=NULL, nda_acknowledged_at = CASE WHEN nda_version = $4 THEN nda_acknowledged_at ELSE NULL END WHERE id=$1 RETURNING ${GRANT_COLUMNS}`, [row.id, input.firmName ?? null, input.clearanceTier, input.ndaVersion, input.expiresAt]);
    return { grant: mapGrant(updated.rows[0] as Record<string, unknown>), reinvited: true };
  }
  return { grant: await upsertAccessGrant({ ...input, investorSubject: PENDING + email, investorEmail: email }), reinvited: false };
}

export async function setGrantTier(id: string, clearanceTier: 1 | 2) {
  const result = await query(`UPDATE data_room_access_grants SET clearance_tier = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING ${GRANT_COLUMNS}`, [id, clearanceTier]);
  return result.rows[0] ? mapGrant(result.rows[0] as Record<string, unknown>) : undefined;
}

export async function acknowledgeNda(subject: string, version: string) {
  const result = await query("UPDATE data_room_access_grants SET nda_acknowledged_at = now(), nda_version = $2 WHERE investor_subject = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING id", [subject, version]);
  return result.rowCount === 1;
}

export async function revokeAccessGrant(id: string, actorSubject: string) {
  const result = await query("UPDATE data_room_access_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING investor_subject", [id]);
  return result.rowCount === 1;
}

// For Access & Settings: one row per investor with a plain status.
export async function listAccessGrants() {
  const result = await query(`SELECT ${GRANT_COLUMNS}, created_at FROM data_room_access_grants ORDER BY created_at DESC`);
  return result.rows.map((r) => {
    const g = mapGrant(r as Record<string, unknown>);
    const signedIn = !g.investorSubject.startsWith(PENDING);
    const status = g.revokedAt ? "revoked" : new Date(g.expiresAt) <= new Date() ? "expired" : !signedIn ? "invited" : g.ndaAcknowledgedAt ? "active" : "nda_pending";
    return { id: g.id, investorEmail: g.investorEmail, firmName: g.firmName, clearanceTier: g.clearanceTier, ndaVersion: g.ndaVersion, ndaAcknowledgedAt: g.ndaAcknowledgedAt, expiresAt: g.expiresAt, revokedAt: g.revokedAt, signedIn, status, createdAt: new Date(String((r as Record<string, unknown>).created_at)).toISOString() };
  });
}

export async function listAuditEvents(limit = 100) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const result = await query("SELECT event_id, event, actor_subject, actor_email, document_id, detail, ip, user_agent, created_at FROM data_room_audit_events ORDER BY created_at DESC LIMIT $1", [safeLimit]);
  return result.rows;
}

export async function updateDocumentStatus(id: string, status: DocumentStatus, actorSubject: string) {
  const result = await query("UPDATE data_room_documents SET status = $2, updated_at = now() WHERE id = $1 RETURNING *", [id, status]);
  return result.rows[0] ? mapDocument(result.rows[0]) : undefined;
}

// Without a label the next minor version is used (1.0 -> 1.1), as in the user guide.
export async function addDocumentVersion(id: string, note: string, actorSubject: string, label?: string) {
  const result = await query("UPDATE data_room_documents SET versions = versions || jsonb_build_array(jsonb_build_object('version', COALESCE($3::text, to_char(COALESCE((SELECT max(substring(v->>'version' from '^[0-9]+(?:[.][0-9]+)?')::numeric) FROM jsonb_array_elements(versions) v), 1) + 0.1, 'FM999990.0')), 'createdAt', now(), 'note', $2::text)), updated_at = now() WHERE id = $1 RETURNING *", [id, note, label ?? null]);
  return result.rows[0] ? mapDocument(result.rows[0]) : undefined;
}

export async function markUploadIntentConsumed(storageKey: string, subject: string, executor: { query: PoolClient["query"] } = getPool()) {
  const result = await executor.query("UPDATE data_room_upload_intents SET consumed_at = now() WHERE storage_key = $1 AND owner_subject = $2 AND consumed_at IS NULL AND expires_at > now() RETURNING id", [storageKey, subject]);
  return result.rowCount === 1;
}
