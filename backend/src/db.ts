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

export async function insertDocument(input: { id: string; title: string; category: string; tier: number; description?: string; source: string; link?: string; storageKey?: string; fileName?: string; mimeType?: string; sizeBytes?: number; ownerSubject: string; status: DocumentStatus }) {
  const now = new Date().toISOString();
  const versions = [{ version: "1.0", createdAt: now, note: "Initial filing" }];
  const result = await query("INSERT INTO data_room_documents (id,title,category,tier,description,source,link,storage_key,file_name,mime_type,size_bytes,owner_subject,status,versions,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$15) RETURNING *", [input.id,input.title,input.category,input.tier,input.description ?? null,input.source,input.link ?? null,input.storageKey ?? null,input.fileName ?? null,input.mimeType ?? null,input.sizeBytes ?? null,input.ownerSubject,input.status,JSON.stringify(versions),now]);
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

export async function getActiveGrant(subject: string): Promise<AccessGrant | undefined> {
  const result = await query("SELECT id, investor_subject, investor_email, firm_name, clearance_tier, nda_version, nda_acknowledged_at, expires_at, revoked_at FROM data_room_access_grants WHERE investor_subject = $1 AND revoked_at IS NULL AND expires_at > now()", [subject]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id), investorSubject: String(row.investor_subject), investorEmail: String(row.investor_email),
    firmName: row.firm_name ? String(row.firm_name) : undefined, clearanceTier: Number(row.clearance_tier) as 1 | 2 | 3,
    ndaVersion: String(row.nda_version), ndaAcknowledgedAt: row.nda_acknowledged_at ? new Date(String(row.nda_acknowledged_at)).toISOString() : undefined,
    expiresAt: new Date(String(row.expires_at)).toISOString(), revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : undefined,
  };
}

export async function upsertAccessGrant(input: { investorSubject: string; investorEmail: string; firmName?: string; clearanceTier: number; ndaVersion: string; expiresAt: string; createdBySubject: string }) {
  const result = await query("INSERT INTO data_room_access_grants (investor_subject, investor_email, firm_name, clearance_tier, nda_version, expires_at, created_by_subject) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (investor_subject) DO UPDATE SET investor_email=excluded.investor_email, firm_name=excluded.firm_name, clearance_tier=excluded.clearance_tier, nda_version=excluded.nda_version, expires_at=excluded.expires_at, revoked_at=NULL RETURNING id, investor_subject, investor_email, firm_name, clearance_tier, nda_version, nda_acknowledged_at, expires_at, revoked_at", [input.investorSubject, input.investorEmail, input.firmName ?? null, input.clearanceTier, input.ndaVersion, input.expiresAt, input.createdBySubject]);
  return getActiveGrant(input.investorSubject) ?? result.rows[0];
}

export async function acknowledgeNda(subject: string, version: string) {
  const result = await query("UPDATE data_room_access_grants SET nda_acknowledged_at = now(), nda_version = $2 WHERE investor_subject = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING id", [subject, version]);
  return result.rowCount === 1;
}

export async function revokeAccessGrant(id: string, actorSubject: string) {
  const result = await query("UPDATE data_room_access_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING investor_subject", [id]);
  return result.rowCount === 1;
}

export async function listAccessGrants() {
  const result = await query("SELECT id, investor_subject, investor_email, firm_name, clearance_tier, nda_version, nda_acknowledged_at, expires_at, revoked_at, created_by_subject, created_at FROM data_room_access_grants ORDER BY created_at DESC");
  return result.rows;
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

export async function addDocumentVersion(id: string, note: string, actorSubject: string) {
  const result = await query("UPDATE data_room_documents SET versions = versions || jsonb_build_array(jsonb_build_object('version', (COALESCE((SELECT max((v->>'version')::numeric) FROM jsonb_array_elements(versions) v), 1) + 1)::text, 'createdAt', now(), 'note', $2)), updated_at = now() WHERE id = $1 RETURNING *", [id, note]);
  return result.rows[0] ? mapDocument(result.rows[0]) : undefined;
}

export async function markUploadIntentConsumed(storageKey: string, subject: string) {
  const result = await query("UPDATE data_room_upload_intents SET consumed_at = now() WHERE storage_key = $1 AND owner_subject = $2 AND consumed_at IS NULL AND expires_at > now() RETURNING id", [storageKey, subject]);
  return result.rowCount === 1;
}
