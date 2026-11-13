import type { PoolClient } from "pg";
import { getPool, query, withTransaction } from "./db.js";
import type { AuthContext } from "./types.js";

// Private investor pipeline. Every route that reaches this module is admin-only
// (Founder or Investor Relations); handler.ts enforces that before calling in.

export const STATUSES = [
  // Main pipeline, in order.
  "Not started", "Drafted", "Check", "Intro requested", "Waiting reply", "Meeting booked", "Due diligence", "Term sheet", "Closed won",
  // Side states.
  "Watch", "On hold", "Passed", "Do not contact",
] as const;
export const PRIORITIES = ["High", "Medium", "Low"] as const;
export const INTEREST = ["Hot", "Warm", "Cold", "Unknown"] as const;
export const YES_NO = ["Yes", "No", "N/A", "Pending"] as const;

type FieldKind = "text" | "longtext" | "url" | "email" | "number" | "date" | "percent" | { oneOf: readonly string[] };
// API field name → [column, kind, label used in history]
const FIELDS = {
  ref: ["ref", "text", "Investor ID"],
  name: ["name", "text", "Name"],
  type: ["type", "text", "Type"],
  stageFocus: ["stage_focus", "text", "Stage focus"],
  sectorFocus: ["sector_focus", "longtext", "Sector focus"],
  geography: ["geography", "text", "Geography"],
  website: ["website", "url", "Website"],
  contactName: ["contact_name", "text", "Contact"],
  contactTitle: ["contact_title", "text", "Contact title"],
  email: ["email", "email", "Email"],
  phone: ["phone", "text", "Phone"],
  linkedin: ["linkedin", "url", "LinkedIn"],
  warmIntroSource: ["warm_intro_source", "text", "Warm intro source"],
  owner: ["owner", "text", "Owner"],
  fundSizeM: ["fund_size_m", "number", "Fund size ($M)"],
  typicalCheckK: ["typical_check_k", "number", "Typical check ($K)"],
  status: ["status", { oneOf: STATUSES }, "Stage"],
  priority: ["priority", { oneOf: PRIORITIES }, "Priority"],
  lastContact: ["last_contact", "date", "Last contact"],
  nextAction: ["next_action", "longtext", "Next action"],
  nextFollowUp: ["next_follow_up", "date", "Next follow-up"],
  interest: ["interest", { oneOf: INTEREST }, "Interest"],
  round: ["round", "text", "Round"],
  amountTargetK: ["amount_target_k", "number", "Amount target ($K)"],
  dataRoomShared: ["data_room_shared", { oneOf: YES_NO }, "Data room shared"],
  deckSent: ["deck_sent", { oneOf: YES_NO }, "Deck sent"],
  ndaSigned: ["nda_signed", { oneOf: YES_NO }, "NDA signed"],
  meeting1: ["meeting_1", "date", "Meeting 1"],
  meeting2: ["meeting_2", "date", "Meeting 2"],
  dueDiligence: ["due_diligence", { oneOf: YES_NO }, "Due diligence"],
  decision: ["decision", { oneOf: YES_NO }, "Decision"],
  probability: ["probability", "percent", "Probability"],
  expectedClose: ["expected_close", "date", "Expected close"],
  notes: ["notes", "longtext", "Notes"],
  introAngle: ["intro_angle", "longtext", "Warm-intro angle"],
} as const satisfies Record<string, readonly [string, FieldKind, string]>;
type FieldName = keyof typeof FIELDS;
const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];

// Field catalogue for API clients (the MCP connector describes these to Claude).
export const INVESTOR_FIELDS = FIELD_NAMES.map((name) => { const kind = FIELDS[name][1]; return { name, label: FIELDS[name][2], kind: typeof kind === "string" ? kind : "choice", choices: typeof kind === "string" ? undefined : [...kind.oneOf] as string[] }; });

export class InvestorInputError extends Error {}

// Keep in step with sql/002_investor_pipeline.sql.
const INVESTOR_DDL = `
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
  status TEXT NOT NULL DEFAULT 'Not started',
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
`;

let schemaReady: Promise<void> | undefined;
async function ensureSchema() {
  schemaReady ??= (async () => {
    await getPool().query(INVESTOR_DDL);
  })().catch((error) => { schemaReady = undefined; throw error; });
  return schemaReady;
}

function clean(field: FieldName, raw: unknown): string | number | null {
  const [, kind, label] = FIELDS[field];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  if (kind === "number" || kind === "percent") {
    const value = typeof raw === "number" ? raw : Number(String(raw).replace(/[,%$\s]/g, ""));
    if (!Number.isFinite(value) || value < 0) throw new InvestorInputError(`${label} must be a positive number`);
    if (kind === "percent") {
      if (value > 100) throw new InvestorInputError(`${label} must be between 0 and 100`);
      return Math.round(value);
    }
    if (value > 1e9) throw new InvestorInputError(`${label} is too large`);
    return value;
  }
  const text = String(raw).trim();
  if (kind === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) throw new InvestorInputError(`${label} must be a date (YYYY-MM-DD)`);
    return text;
  }
  if (typeof kind === "object") {
    const match = kind.oneOf.find((option) => option.toLowerCase() === text.toLowerCase());
    if (!match) throw new InvestorInputError(`${label} must be one of: ${kind.oneOf.join(", ")}`);
    return match;
  }
  const max = kind === "longtext" ? 4000 : 300;
  if (text.length > max) throw new InvestorInputError(`${label} is too long`);
  if (kind === "email" && !/^\S+@\S+\.\S+$/.test(text)) throw new InvestorInputError(`${label} must be an email address`);
  if (kind === "url" && !/^https?:\/\//i.test(text)) return `https://${text}`;
  return text;
}

function cleanAll(body: Record<string, unknown>, { requireName }: { requireName: boolean }) {
  const unknown = Object.keys(body).filter((key) => !FIELD_NAMES.includes(key as FieldName));
  if (unknown.length) throw new InvestorInputError(`Unknown field: ${unknown.join(", ")}`);
  const values: Partial<Record<FieldName, string | number | null>> = {};
  for (const field of FIELD_NAMES) if (field in body) values[field] = clean(field, body[field]);
  if (requireName && !values.name) throw new InvestorInputError("Investor name is required");
  if ("name" in values && !values.name) throw new InvestorInputError("Investor name cannot be blank");
  if ("status" in values && !values.status) throw new InvestorInputError("Stage cannot be blank");
  return values;
}

function toApi(row: Record<string, unknown>) {
  const out: Record<string, unknown> = { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
  for (const field of FIELD_NAMES) {
    const [column, kind] = FIELDS[field];
    const value = row[column];
    if (value === null || value === undefined) out[field] = null;
    else if (kind === "date") out[field] = value instanceof Date ? isoDate(value) : String(value).slice(0, 10);
    else if (kind === "number" || kind === "percent") out[field] = Number(value);
    else out[field] = value;
  }
  return out;
}
function isoDate(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

function describe(field: FieldName, value: unknown) {
  if (value === null || value === undefined || value === "") return "blank";
  if (field === "probability") return `${value}%`;
  const text = String(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

async function nextRef(client: PoolClient) {
  const result = await client.query<{ n: number | null }>("SELECT max(substring(ref from '^INV-(\\d+)$')::int) AS n FROM data_room_investors");
  return `INV-${String((result.rows[0]?.n ?? 0) + 1).padStart(3, "0")}`;
}

async function log(client: PoolClient | { query: PoolClient["query"] }, investorId: string, kind: string, summary: string, auth: AuthContext, occurredAt?: string) {
  await client.query("INSERT INTO data_room_investor_activity (investor_id, kind, summary, actor_subject, actor_email, occurred_at) VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()))", [investorId, kind, summary, auth.subject, auth.email ?? null, occurredAt ?? null]);
}

function actor(auth: AuthContext) { return auth.name || auth.email || "an administrator"; }

export async function listInvestors() {
  await ensureSchema();
  const result = await query("SELECT * FROM data_room_investors ORDER BY ref NULLS LAST, name");
  return { investors: result.rows.map(toApi), options: { statuses: STATUSES, priorities: PRIORITIES, interest: INTEREST, yesNo: YES_NO } };
}

export async function getInvestor(id: string) {
  await ensureSchema();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const result = await query("SELECT * FROM data_room_investors WHERE id=$1", [id]);
  if (!result.rows[0]) return undefined;
  const activity = await query("SELECT id, kind, summary, actor_email, occurred_at FROM data_room_investor_activity WHERE investor_id=$1 ORDER BY occurred_at DESC LIMIT 100", [id]);
  return { investor: toApi(result.rows[0]), activity: activity.rows.map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, actor: r.actor_email, at: r.occurred_at })) };
}

async function insertOne(client: PoolClient, values: Partial<Record<FieldName, string | number | null>>, auth: AuthContext) {
  const ref = (values.ref as string | null | undefined) ?? await nextRef(client);
  const row = { ...values, ref, status: values.status ?? "Not started" };
  const fields = FIELD_NAMES.filter((field) => field in row);
  const columns = fields.map((field) => FIELDS[field][0]);
  const params = fields.map((field) => (row as Record<string, unknown>)[field] ?? null);
  const result = await client.query(`INSERT INTO data_room_investors (${columns.join(",")}, created_by_subject) VALUES (${params.map((_, i) => `$${i + 1}`).join(",")}, $${params.length + 1}) RETURNING *`, [...params, auth.subject]);
  return result.rows[0] as Record<string, unknown>;
}

export async function createInvestor(body: Record<string, unknown>, auth: AuthContext) {
  await ensureSchema();
  const values = cleanAll(body, { requireName: true });
  return withTransaction(async (client) => {
    if (values.ref) {
      const clash = await client.query("SELECT 1 FROM data_room_investors WHERE ref=$1", [values.ref]);
      if (clash.rowCount) throw new InvestorInputError(`Investor ID ${values.ref} is already in use`);
    }
    const dup = await client.query("SELECT ref, name FROM data_room_investors WHERE lower(name)=lower($1)", [values.name]);
    if (dup.rowCount) throw new InvestorInputError(`${dup.rows[0].name} is already in the pipeline (${dup.rows[0].ref})`);
    const row = await insertOne(client, values, auth);
    await log(client, String(row.id), "created", `Added at ${row.status} by ${actor(auth)}`, auth);
    return toApi(row);
  });
}

export async function updateInvestor(id: string, body: Record<string, unknown>, auth: AuthContext) {
  await ensureSchema();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const values = cleanAll(body, { requireName: false });
  if ("ref" in values) throw new InvestorInputError("Investor ID cannot be changed");
  return withTransaction(async (client) => {
    const current = await client.query("SELECT * FROM data_room_investors WHERE id=$1 FOR UPDATE", [id]);
    if (!current.rows[0]) return undefined;
    const before = toApi(current.rows[0]);
    const changed = (Object.keys(values) as FieldName[]).filter((field) => (before[field] ?? null) !== (values[field] ?? null));
    if (!changed.length) return { investor: before, changes: [] as string[] };
    const sets = changed.map((field, i) => `${FIELDS[field][0]}=$${i + 2}`);
    const result = await client.query(`UPDATE data_room_investors SET ${sets.join(",")}, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...changed.map((field) => values[field] ?? null)]);
    const changes = changed.map((field) => field === "notes" || field === "introAngle" ? `${FIELDS[field][2]} updated` : `${FIELDS[field][2]}: ${describe(field, before[field])} → ${describe(field, values[field])}`);
    for (const change of changes) await log(client, id, "change", `${change} by ${actor(auth)}`, auth);
    return { investor: toApi(result.rows[0]), changes };
  });
}

export async function addActivity(id: string, body: Record<string, unknown>, auth: AuthContext) {
  await ensureSchema();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const kind = String(body.kind || "meeting");
  if (!["meeting", "call", "email", "note"].includes(kind)) throw new InvestorInputError("Activity type must be meeting, call, email or note");
  const summary = String(body.summary || "").trim();
  if (!summary) throw new InvestorInputError("Write what happened");
  if (summary.length > 4000) throw new InvestorInputError("Summary is too long");
  const date = body.date ? String(body.date) : undefined;
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) throw new InvestorInputError("Date must be YYYY-MM-DD");
  return withTransaction(async (client) => {
    const current = await client.query("SELECT last_contact FROM data_room_investors WHERE id=$1 FOR UPDATE", [id]);
    if (!current.rows[0]) return undefined;
    await log(client, id, kind, summary, auth, date ? `${date}T12:00:00Z` : undefined);
    if (kind !== "note") {
      const day = date ?? new Date().toISOString().slice(0, 10);
      await client.query("UPDATE data_room_investors SET last_contact = GREATEST(COALESCE(last_contact, $2::date), $2::date), updated_at=now() WHERE id=$1", [id, day]);
    }
    return true;
  });
}

const MAX_IMPORT = 500;
export async function importInvestors(body: Record<string, unknown>, auth: AuthContext) {
  await ensureSchema();
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new InvestorInputError("No investor rows were found in the file");
  if (rows.length > MAX_IMPORT) throw new InvestorInputError(`At most ${MAX_IMPORT} investors can be imported at once`);
  const prepared = rows.map((row, index) => {
    try { return cleanAll(row as Record<string, unknown>, { requireName: true }); }
    catch (error) { throw new InvestorInputError(`Row ${index + 1}: ${error instanceof Error ? error.message : "invalid"}`); }
  });
  return withTransaction(async (client) => {
    const existing = await client.query<{ ref: string | null; name: string }>("SELECT ref, lower(name) AS name FROM data_room_investors");
    const refs = new Set(existing.rows.map((r) => r.ref).filter(Boolean));
    const names = new Set(existing.rows.map((r) => r.name));
    const created: string[] = []; const skipped: string[] = [];
    for (const values of prepared) {
      const name = String(values.name);
      if ((values.ref && refs.has(String(values.ref))) || names.has(name.toLowerCase())) { skipped.push(name); continue; }
      const row = await insertOne(client, values, auth);
      await log(client, String(row.id), "created", `Imported from spreadsheet at ${row.status} by ${actor(auth)}`, auth);
      refs.add(String(row.ref)); names.add(name.toLowerCase()); created.push(name);
    }
    return { created: created.length, skipped: skipped.length, createdNames: created, skippedNames: skipped };
  });
}
