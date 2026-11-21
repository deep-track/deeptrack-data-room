import { query } from "./db.js";
import { ensureSchema, InvestorInputError, listInvestors, OPEN_STATUSES, STATUSES } from "./investors.js";

// Read-only views of the investor pipeline for the daily Investor Relations brief,
// plus the per-user rate limiter used by the MCP connector.

type Row = Record<string, unknown>;
const OPEN = OPEN_STATUSES as readonly string[];

// Today's date in Nairobi (the team's working day), YYYY-MM-DD.
export function todayIn(timeZone = "Africa/Nairobi", now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function addDays(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
// Mon–Fri days after `from` up to and including `to`.
export function workingDaysBetween(from: string, to: string) {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) { const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); if (wd !== 0 && wd !== 6) n++; }
  return n;
}

const brief = (i: Row) => ({ ref: i.ref, name: i.name, organisation: i.organisation, stage: i.status, next_step: i.nextAction, next_step_date: i.nextFollowUp, last_touch_date: i.lastContact, last_touch_by: i.lastTouchBy });

// Pure so it can be tested without a database.
export function summarisePipeline(investors: Row[], today: string, { staleWorkingDays = 10, meetingDays = 7 } = {}) {
  const byStage = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const i of investors) byStage[String(i.status)] = (byStage[String(i.status)] ?? 0) + 1;
  const open = investors.filter((i) => OPEN.includes(String(i.status)) && !(Array.isArray(i.tags) && i.tags.includes("do-not-contact")));
  const horizon = addDays(today, meetingDays);
  const overdue = open.filter((i) => typeof i.nextFollowUp === "string" && i.nextFollowUp < today)
    .sort((a, b) => String(a.nextFollowUp).localeCompare(String(b.nextFollowUp)))
    .map((i) => ({ ...brief(i), days_overdue: Math.round((Date.parse(today) - Date.parse(String(i.nextFollowUp))) / 86400000) }));
  const meetings: Row[] = [];
  for (const i of open) {
    for (const [field, label] of [["meeting1", "Meeting 1"], ["meeting2", "Meeting 2"]] as const) {
      const d = i[field];
      if (typeof d === "string" && d >= today && d <= horizon) meetings.push({ date: d, what: label, ref: i.ref, name: i.name, organisation: i.organisation, stage: i.status });
    }
    if (i.status === "Meeting booked" && typeof i.nextFollowUp === "string" && i.nextFollowUp >= today && i.nextFollowUp <= horizon && !meetings.some((m) => m.ref === i.ref && m.date === i.nextFollowUp))
      meetings.push({ date: i.nextFollowUp, what: i.nextAction ?? "Meeting", ref: i.ref, name: i.name, organisation: i.organisation, stage: i.status });
  }
  meetings.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const stale = open.filter((i) => !i.lastContact || workingDaysBetween(String(i.lastContact), today) >= staleWorkingDays)
    .map((i) => ({ ...brief(i), working_days_since_touch: i.lastContact ? workingDaysBetween(String(i.lastContact), today) : null }))
    .sort((a, b) => (b.working_days_since_touch ?? 1e9) - (a.working_days_since_touch ?? 1e9));
  const committedRows = investors.filter((i) => i.status === "Committed" || i.status === "Closed");
  const recorded = committedRows.filter((i) => typeof i.amountTargetK === "number");
  return {
    today, total: investors.length, by_stage: byStage,
    committed: { investors: committedRows.length, amount_usd_k_recorded: recorded.reduce((s, i) => s + Number(i.amountTargetK), 0), without_amount: committedRows.length - recorded.length },
    overdue_next_steps: overdue,
    meetings_next_7_days: meetings,
    stale: { rule: `no touch in ${staleWorkingDays}+ working days (open stages only)`, count: stale.length, investors: stale },
    awaiting_our_reply: open.filter((i) => i.lastTouchBy === "investor").map(brief),
  };
}

export async function pipelineSummary(today = todayIn()) {
  return summarisePipeline((await listInvestors()).investors, today);
}

// Who viewed or downloaded which documents, and NDA acceptances, since a date.
// Matched to pipeline investors by email (and to access grants for the firm name).
const VIEW_EVENTS = ["document_viewed", "document_download_url_created", "nda_acknowledged", "document_list"];
export async function dataRoomActivity(since: string, includeAdmins = false) {
  await ensureSchema();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since))) throw new InvestorInputError("since must be a date (YYYY-MM-DD)");
  const events = await query(`
    SELECT e.event, e.actor_email, e.actor_subject, e.detail, e.created_at, d.title AS document_title, d.category AS document_category,
           g.firm_name, i.ref AS investor_ref, i.name AS investor_name, i.organisation AS investor_organisation, i.status AS investor_stage
    FROM data_room_audit_events e
    LEFT JOIN data_room_documents d ON d.id = e.document_id
    LEFT JOIN LATERAL (SELECT firm_name FROM data_room_access_grants g WHERE g.investor_subject = e.actor_subject OR lower(g.investor_email) = lower(e.actor_email) ORDER BY g.created_at DESC LIMIT 1) g ON true
    LEFT JOIN data_room_investors i ON e.actor_email IS NOT NULL AND lower(i.email) = lower(e.actor_email)
    WHERE e.event = ANY($1) AND e.created_at >= $2::date
      AND ($3 OR NOT EXISTS (SELECT 1 FROM data_room_audit_events a WHERE a.actor_subject = e.actor_subject AND a.event IN ('investor_created','investor_updated','document_created','access_grant_created','investor_invited')))
    ORDER BY e.created_at DESC LIMIT 1000`, [VIEW_EVENTS, since, includeAdmins]);
  const people = new Map<string, Row>();
  for (const e of events.rows) {
    const key = String(e.actor_email ?? e.actor_subject);
    const p = people.get(key) ?? { email: e.actor_email, firm: e.firm_name, investor: e.investor_ref ? { ref: e.investor_ref, name: e.investor_name, organisation: e.investor_organisation, stage: e.investor_stage } : null, nda_accepted_at: null, last_seen: e.created_at, views: 0, downloads: 0, documents: [] as string[] };
    if (e.event === "nda_acknowledged") p.nda_accepted_at ??= e.created_at;
    if (e.event === "document_viewed") p.views = Number(p.views) + 1;
    if (e.event === "document_download_url_created") p.downloads = Number(p.downloads) + 1;
    const docs = p.documents as string[];
    if (e.document_title && !docs.includes(String(e.document_title))) docs.push(String(e.document_title));
    people.set(key, p);
  }
  const list = [...people.values()];
  return {
    since, people: list.length, matched_to_pipeline: list.filter((p) => p.investor).length,
    nda_acceptances: list.filter((p) => p.nda_accepted_at).map((p) => ({ email: p.email, firm: p.firm, investor: p.investor, at: p.nda_accepted_at })),
    viewers: list,
    events: events.rows.slice(0, 200).map((e) => ({ at: e.created_at, event: e.event, email: e.actor_email, document: e.document_title, investor: e.investor_ref })),
  };
}

// Fixed-window rate limit kept in Postgres so it holds across Lambda instances.
export class RateLimitError extends Error { constructor(public retryAfterSeconds: number, message: string) { super(message); } }
export async function rateLimit(key: string, limit: number, windowSeconds = 60) {
  await ensureSchema();
  const result = await query<{ count: number; window_start: Date }>(`
    INSERT INTO data_room_rate_limits (key, window_start, count)
    VALUES ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = data_room_rate_limits.count + 1
    RETURNING count, window_start`, [key, windowSeconds]);
  if (Math.random() < 0.02) await query("DELETE FROM data_room_rate_limits WHERE window_start < now() - interval '1 day'");
  const row = result.rows[0];
  if (row.count > limit) {
    const retry = Math.max(1, Math.ceil((new Date(row.window_start).getTime() + windowSeconds * 1000 - Date.now()) / 1000));
    throw new RateLimitError(retry, `Rate limit: at most ${limit} requests per ${windowSeconds}s. Try again in ${retry}s.`);
  }
}
