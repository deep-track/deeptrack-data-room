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
