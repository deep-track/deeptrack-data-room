import type { PoolClient } from "pg";
import { ensureBaseSchema, getPool, query, withTransaction } from "./db.js";
import type { AuthContext } from "./types.js";

// Private investor pipeline. Every route that reaches this module is admin-only
// (Founder or Investor Relations); handler.ts enforces that before calling in.

// Pipeline stages (Nov 2026 list). The main funnel runs Intro pending → Closed;
// Passed, Reconnect later and Banned are side states.
export const STATUSES = [
  "Intro pending", "Contacted", "Replied", "Deck sent", "Meeting booked", "Diligence", "Committed", "Closed",
  "Passed", "Reconnect later", "Banned",
] as const;
export const OPEN_STATUSES = ["Intro pending", "Contacted", "Replied", "Deck sent", "Meeting booked", "Diligence", "Committed"] as const;
export const TYPES = ["VC", "Angel", "Angel network", "Accelerator", "Grant", "Warm introducer", "Capital advisor", "Connector", "Reference"] as const;
export const ROUNDS = ["pre-seed-750k", "bridge-100k"] as const;
export const TOUCH_BY = ["bryan", "investor"] as const;
export const ACTIVITY_KINDS = ["email", "call", "meeting", "note", "form", "intro"] as const;
export const PRIORITIES = ["High", "Medium", "Low"] as const;
export const INTEREST = ["Hot", "Warm", "Cold", "Unknown"] as const;
export const YES_NO = ["Yes", "No", "N/A", "Pending"] as const;
export const DO_NOT_CONTACT = "do-not-contact";
export const DEFAULT_STAGE = "Intro pending";
export const DEFAULT_ROUND = "pre-seed-750k";

// Stage names used before Nov 2026 (and in older spreadsheets) → current stage.
export const LEGACY_STAGES: Record<string, (typeof STATUSES)[number]> = {
  "not started": "Intro pending", "drafted": "Intro pending", "check": "Intro pending", "intro requested": "Intro pending",
  "waiting reply": "Contacted", "due diligence": "Diligence", "term sheet": "Committed", "closed won": "Closed",
  "watch": "Reconnect later", "on hold": "Reconnect later", "do not contact": "Banned",
};

type FieldKind = "text" | "longtext" | "url" | "email" | "number" | "date" | "percent" | "tags" | { oneOf: readonly string[] };
// API field name → [column, kind, label used in history]
const FIELDS = {
  ref: ["ref", "text", "Investor ID"],
  name: ["name", "text", "Name"],
  organisation: ["organisation", "text", "Organisation"],
  type: ["type", { oneOf: TYPES }, "Type"],
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
  lastContact: ["last_contact", "date", "Last touch"],
  lastTouchBy: ["last_touch_by", { oneOf: TOUCH_BY }, "Last touch by"],
  nextAction: ["next_action", "longtext", "Next step"],
  nextFollowUp: ["next_follow_up", "date", "Next step date"],
  interest: ["interest", { oneOf: INTEREST }, "Interest"],
  round: ["round", { oneOf: ROUNDS }, "Round"],
  amountTargetK: ["amount_target_k", "number", "Amount ($K)"],
  dataRoomShared: ["data_room_shared", { oneOf: YES_NO }, "Data room shared"],
  deckSent: ["deck_sent", { oneOf: YES_NO }, "Deck sent"],
  ndaSigned: ["nda_signed", { oneOf: YES_NO }, "NDA signed"],
  meeting1: ["meeting_1", "date", "Meeting 1"],
  meeting2: ["meeting_2", "date", "Meeting 2"],
  dueDiligence: ["due_diligence", { oneOf: YES_NO }, "Due diligence"],
  decision: ["decision", { oneOf: YES_NO }, "Decision"],
  probability: ["probability", "percent", "Probability"],
  expectedClose: ["expected_close", "date", "Expected close"],
  hook: ["hook", "longtext", "Hook"],
  sourceUrl: ["source_url", "url", "Source link"],
  tags: ["tags", "tags", "Tags"],
  notes: ["notes", "longtext", "Notes"],
  introAngle: ["intro_angle", "longtext", "Warm-intro angle"],
} as const satisfies Record<string, readonly [string, FieldKind, string]>;
export type FieldName = keyof typeof FIELDS;
const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];
type Value = string | number | string[] | null;
type Values = Partial<Record<FieldName, Value>>;
export type Change = { field: FieldName; before: unknown; after: unknown };

// Field catalogue for API clients (the MCP connector describes these to Claude).
export const INVESTOR_FIELDS = FIELD_NAMES.map((name) => { const kind = FIELDS[name][1]; return { name, label: FIELDS[name][2], kind: typeof kind === "string" ? kind : "choice", choices: typeof kind === "string" ? undefined : [...kind.oneOf] as string[] }; });

export class InvestorInputError extends Error {}

// Keep in step with sql/002_investor_pipeline.sql and sql/003_investor_pipeline_v2.sql.
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
  status TEXT NOT NULL DEFAULT 'Intro pending',
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

const LEGACY_CASE = `CASE lower(status) ${Object.entries(LEGACY_STAGES).map(([from, to]) => `WHEN '${from}' THEN '${to}'`).join(" ")} END`;

// Nov 2026 pipeline model: new columns, the new stage list, rounds and tags, an
// append-only audit log and a per-user rate-limit table. Idempotent; runs once per
// cold start under an advisory lock so concurrent Lambdas don't race.
export const MIGRATION_V2 = `
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
    CASE WHEN lower(status) = 'waiting reply' AND deck_sent = 'Yes' THEN 'Deck sent' ELSE ${LEGACY_CASE} END AS new_status
  FROM data_room_investors WHERE lower(status) IN (${Object.keys(LEGACY_STAGES).map((s) => `'${s}'`).join(",")})
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
  notes = CASE WHEN round IS NOT NULL AND btrim(round) <> '' THEN concat_ws(E'\\n', notes, 'Round (before Nov 2026): ' || round) ELSE notes END,
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
`;

let schemaReady: Promise<void> | undefined;
export async function ensureSchema() {
  schemaReady ??= (async () => {
    await ensureBaseSchema(); // audit table must exist before the append-only trigger
    await getPool().query(INVESTOR_DDL);
    await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('data_room_investor_pipeline_v2'))");
      await client.query(MIGRATION_V2);
    });
  })().catch((error) => { schemaReady = undefined; throw error; });
  return schemaReady;
}

function clean(field: FieldName, raw: unknown): Value {
  const [, kind, label] = FIELDS[field];
  if (raw === null || raw === undefined) return kind === "tags" ? [] : null;
  if (kind === "tags") {
    const list = Array.isArray(raw) ? raw : String(raw).split(/[,;]/);
    const tags = [...new Set(list.map((t) => String(t).trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean))];
    const bad = tags.find((t) => !/^[a-z0-9][a-z0-9-]{0,39}$/.test(t));
    if (bad) throw new InvestorInputError(`Tag "${bad}" must be lowercase letters, digits and dashes (e.g. last-nudge-sent)`);
    if (tags.length > 20) throw new InvestorInputError("At most 20 tags");
    return tags.sort();
  }
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) throw new InvestorInputError(`${label} must be a date (YYYY-MM-DD), got "${text}"`);
    return text;
  }
  if (typeof kind === "object") {
    const wanted = field === "status" ? (LEGACY_STAGES[text.toLowerCase()] ?? text) : text;
    const match = kind.oneOf.find((option) => option.toLowerCase() === wanted.toLowerCase());
    if (!match) throw new InvestorInputError(`${label} must be one of: ${kind.oneOf.join(", ")} (got "${text}")`);
    return match;
  }
  const max = kind === "longtext" ? 4000 : 300;
  if (text.length > max) throw new InvestorInputError(`${label} is too long (max ${max} characters)`);
  if (kind === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new InvestorInputError(`${label} must be an email address, got "${text}"`);
    return text.toLowerCase();
  }
  if (kind === "url" && !/^https?:\/\//i.test(text)) return `https://${text}`;
  return text;
}

function cleanAll(body: Record<string, unknown>, { requireName }: { requireName: boolean }) {
  const unknown = Object.keys(body).filter((key) => !FIELD_NAMES.includes(key as FieldName));
  if (unknown.length) throw new InvestorInputError(`Unknown field: ${unknown.join(", ")}. Known fields: ${FIELD_NAMES.join(", ")}`);
  const values: Values = {};
  for (const field of FIELD_NAMES) if (field in body) values[field] = clean(field, body[field]);
  if (requireName && !values.name) throw new InvestorInputError("Investor name is required");
  if ("name" in values && !values.name) throw new InvestorInputError("Investor name cannot be blank");
  if ("status" in values && !values.status) throw new InvestorInputError("Stage cannot be blank");
  if ("round" in values && !values.round) values.round = DEFAULT_ROUND;
  return values;
}

export function toApi(row: Record<string, unknown>) {
  const out: Record<string, unknown> = { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
  for (const field of FIELD_NAMES) {
    const [column, kind] = FIELDS[field];
    const value = row[column];
    if (kind === "tags") out[field] = Array.isArray(value) ? value : [];
    else if (value === null || value === undefined) out[field] = null;
    else if (kind === "date") out[field] = value instanceof Date ? isoDate(value) : String(value).slice(0, 10);
    else if (kind === "number" || kind === "percent") out[field] = Number(value);
    else out[field] = value;
  }
  return out;
}
function isoDate(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

function describe(field: FieldName, value: unknown) {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (value === null || value === undefined || value === "") return "blank";
  if (field === "probability") return `${value}%`;
  const text = String(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function isBlocked(investor: Record<string, unknown>) {
  return investor.status === "Banned" || (Array.isArray(investor.tags) && investor.tags.includes(DO_NOT_CONTACT));
}
function blockedError(investor: Record<string, unknown>, what: string) {
  const why = investor.status === "Banned" ? "is Banned" : "is tagged do-not-contact";
  return new InvestorInputError(`${investor.name} (${investor.ref}) ${why}, so ${what} is refused. Only a stage change by an admin is allowed (move_stage, with a reason).`);
}

function checkRound(row: Record<string, unknown>) {
  if (row.round === "bridge-100k" && !/hayes/i.test(`${row.name ?? ""} ${row.organisation ?? ""} ${row.contactName ?? ""}`))
    throw new InvestorInputError("Round bridge-100k is only for Isaak Hayes; use pre-seed-750k for everyone else");
}

async function checkEmail(client: PoolClient, email: unknown, exceptId?: string) {
  if (typeof email !== "string" || !email) return;
  const clash = await client.query("SELECT ref, name FROM data_room_investors WHERE lower(email)=lower($1) AND ($2::uuid IS NULL OR id <> $2::uuid)", [email, exceptId ?? null]);
  if (clash.rowCount) throw new InvestorInputError(`Email ${email} already belongs to ${clash.rows[0].name} (${clash.rows[0].ref}); update that investor instead`);
}

async function nextRef(client: PoolClient) {
  const result = await client.query<{ n: number | null }>("SELECT max(substring(ref from '^INV-(\\d+)$')::int) AS n FROM data_room_investors");
  return `INV-${String((result.rows[0]?.n ?? 0) + 1).padStart(3, "0")}`;
}

type ActivityExtra = { occurredAt?: string; direction?: string | null; link?: string | null };
async function log(client: PoolClient | { query: PoolClient["query"] }, investorId: string, kind: string, summary: string, auth: AuthContext, extra: ActivityExtra = {}) {
  await client.query("INSERT INTO data_room_investor_activity (investor_id, kind, summary, actor_subject, actor_email, occurred_at, direction, link) VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()),$7,$8)", [investorId, kind, summary, auth.subject, auth.email ?? null, extra.occurredAt ?? null, extra.direction ?? null, extra.link ?? null]);
}

function actor(auth: AuthContext) { return auth.name || auth.email || "an administrator"; }

export const investorOptions = { statuses: STATUSES, types: TYPES, rounds: ROUNDS, lastTouchBy: TOUCH_BY, activityKinds: ACTIVITY_KINDS, priorities: PRIORITIES, interest: INTEREST, yesNo: YES_NO };

export async function listInvestors() {
  await ensureSchema();
  const result = await query("SELECT * FROM data_room_investors ORDER BY ref NULLS LAST, name");
  return { investors: result.rows.map(toApi), options: investorOptions };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getInvestor(id: string, activityLimit = 100) {
  await ensureSchema();
  if (!UUID.test(id)) return undefined;
  const result = await query("SELECT * FROM data_room_investors WHERE id=$1", [id]);
  if (!result.rows[0]) return undefined;
  const limit = Math.min(Math.max(Math.trunc(activityLimit) || 100, 1), 200);
  const activity = await query("SELECT id, kind, summary, actor_email, occurred_at, direction, link FROM data_room_investor_activity WHERE investor_id=$1 ORDER BY occurred_at DESC LIMIT $2", [id, limit]);
  return { investor: toApi(result.rows[0]), activity: activity.rows.map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, actor: r.actor_email, at: r.occurred_at, direction: r.direction, link: r.link })) };
}

async function insertOne(client: PoolClient, values: Values, auth: AuthContext) {
  const ref = (values.ref as string | null | undefined) ?? await nextRef(client);
  const row: Values = { ...values, ref, status: values.status ?? DEFAULT_STAGE, round: values.round ?? DEFAULT_ROUND };
  const fields = FIELD_NAMES.filter((field) => field in row);
  const columns = fields.map((field) => FIELDS[field][0]);
  const params = fields.map((field) => row[field] ?? null);
  const result = await client.query(`INSERT INTO data_room_investors (${columns.join(",")}, created_by_subject) VALUES (${params.map((_, i) => `$${i + 1}`).join(",")}, $${params.length + 1}) RETURNING *`, [...params, auth.subject]);
  return result.rows[0] as Record<string, unknown>;
}

async function createWith(client: PoolClient, values: Values, auth: AuthContext, how: string) {
  if (values.ref) {
    const clash = await client.query("SELECT 1 FROM data_room_investors WHERE ref=$1", [values.ref]);
    if (clash.rowCount) throw new InvestorInputError(`Investor ID ${values.ref} is already in use`);
  }
  const dup = await client.query("SELECT ref, name FROM data_room_investors WHERE lower(name)=lower($1) AND lower(coalesce(organisation,''))=lower(coalesce($2,''))", [values.name, values.organisation ?? null]);
  if (dup.rowCount) throw new InvestorInputError(`${dup.rows[0].name} is already in the pipeline (${dup.rows[0].ref}); update that investor instead`);
  await checkEmail(client, values.email);
  checkRound({ ...values, round: values.round ?? DEFAULT_ROUND });
  const row = await insertOne(client, values, auth);
  await log(client, String(row.id), "created", `${how} at ${row.status} by ${actor(auth)}`, auth);
  return toApi(row);
}

export async function createInvestor(body: Record<string, unknown>, auth: AuthContext) {
  await ensureSchema();
  const values = cleanAll(body, { requireName: true });
  return withTransaction((client) => createWith(client, values, auth, "Added"));
}

// Apply already-cleaned values to a locked row. Returns the changes made.
async function applyUpdate(client: PoolClient, id: string, before: Record<string, unknown>, values: Values, auth: AuthContext, note = "") {
  const changed = (Object.keys(values) as FieldName[]).filter((field) => !same(before[field], values[field]));
  if (!changed.length) return { investor: before, changes: [] as string[], diff: [] as Change[] };
  if (isBlocked(before) && changed.some((f) => f !== "status")) throw blockedError(before, "changing it");
  if (changed.includes("email")) await checkEmail(client, values.email, id);
  checkRound({ ...before, ...values });
  const sets = changed.map((field, i) => `${FIELDS[field][0]}=$${i + 2}`);
  const result = await client.query(`UPDATE data_room_investors SET ${sets.join(",")}, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...changed.map((field) => values[field] ?? null)]);
  const diff = changed.map((field) => ({ field, before: before[field] ?? null, after: values[field] ?? null }));
  const changes = changed.map((field) => field === "notes" || field === "introAngle" || field === "hook" ? `${FIELDS[field][2]} updated` : `${FIELDS[field][2]}: ${describe(field, before[field])} → ${describe(field, values[field])}`);
  for (const change of changes) await log(client, id, "change", `${change}${note} by ${actor(auth)}`, auth);
  return { investor: toApi(result.rows[0]), changes, diff };
}

export async function updateInvestor(id: string, body: Record<string, unknown>, auth: AuthContext) {
  await ensureSchema();
  if (!UUID.test(id)) return undefined;
  const values = cleanAll(body, { requireName: false });
  if ("ref" in values) throw new InvestorInputError("Investor ID cannot be changed");
  return withTransaction(async (client) => {
    const current = await client.query("SELECT * FROM data_room_investors WHERE id=$1 FOR UPDATE", [id]);
    if (!current.rows[0]) return undefined;
    return applyUpdate(client, id, toApi(current.rows[0]), values, auth);
  });
}

// Stage change with a reason (required for Passed and Banned, and to lift do-not-contact).
// This is the one write allowed on a Banned or do-not-contact investor.
export async function moveStage(id: string, body: Record<string, unknown>, auth: AuthContext) {
  await ensureSchema();
  if (!UUID.test(id)) return undefined;
  const stage = clean("status", body.stage) as string | null;
  if (!stage) throw new InvestorInputError(`Say which stage: ${STATUSES.join(", ")}`);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const lift = body.removeDoNotContact === true;
  if ((stage === "Passed" || stage === "Banned") && !reason) throw new InvestorInputError(`A reason is required to move an investor to ${stage}`);
  if (lift && !reason) throw new InvestorInputError("A reason is required to remove the do-not-contact tag");
  if (reason.length > 1000) throw new InvestorInputError("Reason is too long (max 1000 characters)");
  return withTransaction(async (client) => {
    const current = await client.query("SELECT * FROM data_room_investors WHERE id=$1 FOR UPDATE", [id]);
    if (!current.rows[0]) return undefined;
    const before = toApi(current.rows[0]);
    const tags = before.tags as string[];
    if (lift && !tags.includes(DO_NOT_CONTACT)) throw new InvestorInputError(`${before.name} is not tagged do-not-contact`);
    if (before.status === stage && !lift) return { investor: before, changes: [] as string[], diff: [] as Change[] };
    const values: Values = { status: stage };
    const sets = ["status=$2"]; const params: unknown[] = [id, stage];
    if (lift) { values.tags = tags.filter((t) => t !== DO_NOT_CONTACT); sets.push("tags=$3"); params.push(values.tags); }
    const result = await client.query(`UPDATE data_room_investors SET ${sets.join(",")}, updated_at=now() WHERE id=$1 RETURNING *`, params);
    const diff: Change[] = [{ field: "status", before: before.status, after: stage }];
    if (lift) diff.push({ field: "tags", before: tags, after: values.tags });
    const summary = `Stage: ${before.status} → ${stage}${lift ? "; do-not-contact removed" : ""}${reason ? `. Reason: ${reason}` : ""} by ${actor(auth)}`;
    await log(client, id, "change", summary, auth);
    return { investor: toApi(result.rows[0]), changes: [summary], diff };
  });
}

export async function addActivity(id: string, body: Record<string, unknown>, auth: AuthContext) {
  await ensureSchema();
  if (!UUID.test(id)) return undefined;
  const kind = String(body.kind || "meeting");
  if (!(ACTIVITY_KINDS as readonly string[]).includes(kind)) throw new InvestorInputError(`Activity type must be one of: ${ACTIVITY_KINDS.join(", ")}`);
  const summary = String(body.summary || "").trim();
  if (!summary) throw new InvestorInputError("Write what happened (summary)");
  if (summary.length > 4000) throw new InvestorInputError("Summary is too long (max 4000 characters)");
  const date = body.date ? String(body.date) : undefined;
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) throw new InvestorInputError("Date must be YYYY-MM-DD");
  const direction = body.direction === undefined || body.direction === null ? "out" : String(body.direction);
  if (!["in", "out"].includes(direction)) throw new InvestorInputError("Direction must be in (from the investor) or out (from us)");
  const link = body.link ? String(body.link).trim() : null;
  if (link && !/^https:\/\/\S+$/i.test(link)) throw new InvestorInputError("Link must be an https:// URL");
  const next: Values = {};
  if (body.nextStep !== undefined) next.nextAction = clean("nextAction", body.nextStep);
  if (body.nextStepDate !== undefined) next.nextFollowUp = clean("nextFollowUp", body.nextStepDate);
  return withTransaction(async (client) => {
    const current = await client.query("SELECT * FROM data_room_investors WHERE id=$1 FOR UPDATE", [id]);
    if (!current.rows[0]) return undefined;
    const before = toApi(current.rows[0]);
    if (isBlocked(before)) throw blockedError(before, "logging activity");
    await log(client, id, kind, summary, auth, { occurredAt: date ? `${date}T12:00:00Z` : undefined, direction, link });
    const values: Values = { ...next };
    if (kind !== "note") {
      const day = date ?? new Date().toISOString().slice(0, 10);
      if (!before.lastContact || day >= String(before.lastContact)) { values.lastContact = day; values.lastTouchBy = direction === "in" ? "investor" : "bryan"; }
    }
    const changed = (Object.keys(values) as FieldName[]).filter((f) => !same(before[f], values[f]));
    if (changed.length) await client.query(`UPDATE data_room_investors SET ${changed.map((f, i) => `${FIELDS[f][0]}=$${i + 2}`).join(",")}, updated_at=now() WHERE id=$1`, [id, ...changed.map((f) => values[f] ?? null)]);
    const diff: Change[] = changed.map((field) => ({ field, before: before[field] ?? null, after: values[field] ?? null }));
    return { diff, activity: { kind, summary, date: date ?? null, direction, link } };
  });
}

// ---- Bulk import (dry run by default) ----------------------------------------

const MAX_IMPORT = 500;
type PlanRow = { row: number; action: "create" | "update" | "unchanged" | "conflict"; name: string; investor?: string; matchedBy?: "email" | "name+organisation"; changes?: string[]; reason?: string };

export async function bulkImport(body: Record<string, unknown>, auth: AuthContext) {
  await ensureSchema();
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new InvestorInputError("rows must be a non-empty array");
  if (rows.length > MAX_IMPORT) throw new InvestorInputError(`At most ${MAX_IMPORT} rows per import`);
  const commit = body.commit === true;
  return withTransaction(async (client) => {
    const existing = (await client.query("SELECT * FROM data_room_investors FOR UPDATE")).rows.map(toApi);
    const byEmail = new Map(existing.filter((i) => i.email).map((i) => [String(i.email).toLowerCase(), i]));
    const key = (name: unknown, org: unknown) => `${String(name ?? "").trim().toLowerCase()}|${String(org ?? "").trim().toLowerCase()}`;
    const byName = new Map(existing.map((i) => [key(i.name, i.organisation), i]));
    const seen = new Set<string>();
    const plan: PlanRow[] = [];
    for (const [index, raw] of rows.entries()) {
      const n = index + 1;
      const name = String((raw as Record<string, unknown>)?.name ?? "").trim() || `(row ${n})`;
      let values: Values;
      try {
        // Empty cells never clear existing data in an import.
        const given = Object.fromEntries(Object.entries((raw ?? {}) as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && v.length === 0)));
        values = cleanAll(given, { requireName: true });
        if ("ref" in values) throw new InvestorInputError("ref cannot be imported");
      } catch (error) { plan.push({ row: n, action: "conflict", name, reason: error instanceof Error ? error.message : "invalid row" }); continue; }
      const emailHit = values.email ? byEmail.get(String(values.email)) : undefined;
      const nameHit = byName.get(key(values.name, values.organisation));
      const fileKey = values.email ? `e:${values.email}` : `n:${key(values.name, values.organisation)}`;
      if (seen.has(fileKey)) { plan.push({ row: n, action: "conflict", name, reason: "Duplicate of an earlier row in this import" }); continue; }
      seen.add(fileKey);
      if (emailHit && nameHit && emailHit.id !== nameHit.id) { plan.push({ row: n, action: "conflict", name, reason: `Email matches ${emailHit.name} (${emailHit.ref}) but name + organisation match ${nameHit.name} (${nameHit.ref})` }); continue; }
      if (!emailHit && nameHit && values.email && nameHit.email && nameHit.email !== values.email) { plan.push({ row: n, action: "conflict", name, investor: String(nameHit.ref), reason: `Name + organisation match ${nameHit.ref}, but it has a different email (${nameHit.email})` }); continue; }
      const target = emailHit ?? nameHit;
      if (!target) {
        try {
          checkRound({ ...values, round: values.round ?? DEFAULT_ROUND });
          if (commit) { const created = await createWith(client, values, auth, "Imported"); plan.push({ row: n, action: "create", name, investor: String(created.ref) }); }
          else plan.push({ row: n, action: "create", name });
        } catch (error) { if (!(error instanceof InvestorInputError)) throw error; plan.push({ row: n, action: "conflict", name, reason: error.message }); }
        continue;
      }
      const matchedBy = emailHit ? "email" as const : "name+organisation" as const;
      const changedFields = (Object.keys(values) as FieldName[]).filter((f) => !same(target[f], values[f]));
      if (!changedFields.length) { plan.push({ row: n, action: "unchanged", name, investor: String(target.ref), matchedBy }); continue; }
      if (isBlocked(target)) { plan.push({ row: n, action: "conflict", name, investor: String(target.ref), matchedBy, reason: blockedError(target, "importing changes").message }); continue; }
      const changes = changedFields.map((f) => `${FIELDS[f][2]}: ${describe(f, target[f])} → ${describe(f, values[f])}`);
      const updates = Object.fromEntries(changedFields.map((f) => [f, values[f]])) as Values;
      try {
        checkRound({ ...target, ...updates });
        if (commit) await applyUpdate(client, String(target.id), target, updates, auth, " (import)");
        plan.push({ row: n, action: "update", name, investor: String(target.ref), matchedBy, changes });
      } catch (error) { if (!(error instanceof InvestorInputError)) throw error; plan.push({ row: n, action: "conflict", name, investor: String(target.ref), matchedBy, reason: error.message }); }
    }
    const count = (a: PlanRow["action"]) => plan.filter((p) => p.action === a).length;
    return { committed: commit, creates: count("create"), updates: count("update"), unchanged: count("unchanged"), conflicts: count("conflict"), rows: plan,
      next: commit ? undefined : "Dry run only. Nothing was saved. Call again with commit: true to apply the creates and updates (conflict rows are skipped)." };
  });
}

// Spreadsheet import from the web app (create-only; existing investors are skipped).
export async function importInvestors(body: Record<string, unknown>, auth: AuthContext) {
  await ensureSchema();
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new InvestorInputError("No investor rows were found in the file");
  if (rows.length > MAX_IMPORT) throw new InvestorInputError(`At most ${MAX_IMPORT} investors can be imported at once`);
  const prepared = rows.map((row, index) => {
    // Older spreadsheets use free-text investor types: keep an unknown type in notes instead of failing the file.
    const input = { ...(row as Record<string, unknown>) };
    if (typeof input.type === "string" && input.type.trim() && !TYPES.some((t) => t.toLowerCase() === String(input.type).trim().toLowerCase())) {
      input.notes = [input.notes, `Type (from spreadsheet): ${input.type}`].filter(Boolean).join("\n");
      delete input.type;
    }
    try { return cleanAll(input, { requireName: true }); }
    catch (error) { throw new InvestorInputError(`Row ${index + 1}: ${error instanceof Error ? error.message : "invalid"}`); }
  });
  return withTransaction(async (client) => {
    const existing = await client.query<{ ref: string | null; name: string; email: string | null }>("SELECT ref, lower(name) AS name, lower(email) AS email FROM data_room_investors");
    const refs = new Set(existing.rows.map((r) => r.ref).filter(Boolean));
    const names = new Set(existing.rows.map((r) => r.name));
    const emails = new Set(existing.rows.map((r) => r.email).filter(Boolean));
    const created: string[] = []; const skipped: string[] = [];
    for (const values of prepared) {
      const name = String(values.name);
      if ((values.ref && refs.has(String(values.ref))) || names.has(name.toLowerCase()) || (values.email && emails.has(String(values.email)))) { skipped.push(name); continue; }
      checkRound({ ...values, round: values.round ?? DEFAULT_ROUND });
      const row = await insertOne(client, values, auth);
      await log(client, String(row.id), "created", `Imported from spreadsheet at ${row.status} by ${actor(auth)}`, auth);
      refs.add(String(row.ref)); names.add(name.toLowerCase()); if (values.email) emails.add(String(values.email)); created.push(name);
    }
    return { created: created.length, skipped: skipped.length, createdNames: created, skippedNames: skipped };
  });
}
