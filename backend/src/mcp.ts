// Remote MCP server for the data room (Streamable HTTP, stateless JSON replies).
// Claude signs in through Auth0 like the web app. Only the emails in the MCP
// allow-list (auth.ts) may use it. Every tool runs through the same API route the
// web app uses, so validation, Banned/do-not-contact rules and the audit log are identical.
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { markMcpCall, mcpAllowedEmails, requireAuth } from "./auth.js";
import { isConnectorToken, oauthBase, verifyConnectorToken } from "./oauth.js";
import { ACTIVITY_KINDS, ROUNDS, STATUSES, TOUCH_BY, TYPES } from "./investors.js";
import { rateLimit, RateLimitError } from "./pipeline.js";
import { FOLDER_KEYS } from "./taxonomy.js";
import type { AuthContext } from "./types.js";

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;
type Json = Record<string, unknown>;
type ApiResult = { status: number; body: unknown };
type Call = (method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string>) => Promise<ApiResult>;

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SCOPES = ["openid", "profile", "email"];
const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store" };
// Per signed-in user: all MCP requests, and write tool calls.
const LIMIT_REQUESTS_PER_MINUTE = Number(process.env.MCP_RATE_LIMIT_PER_MINUTE || 120);
const LIMIT_WRITES_PER_MINUTE = Number(process.env.MCP_WRITE_LIMIT_PER_MINUTE || 30);

export function publicBase(event: APIGatewayProxyEventV2) { return `https://${event.requestContext.domainName}`; }
export function mcpResource(event: APIGatewayProxyEventV2) { return process.env.MCP_RESOURCE_URL?.trim() || `${publicBase(event)}/mcp`; }
function metadataUrl(event: APIGatewayProxyEventV2) {
  const resource = mcpResource(event);
  // Behind investors.deeptrack.io/api the metadata lives next to the MCP path.
  return `${resource.replace(/\/mcp$/, "")}/.well-known/oauth-protected-resource`;
}

// RFC 9728 protected-resource metadata: Claude signs in through the data room's own
// authorization server (oauth.ts), which hands off to Auth0 for Google sign-in.
export function protectedResourceMetadata(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 {
  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ resource: mcpResource(event), authorization_servers: [oauthBase(mcpResource(event))], scopes_supported: SCOPES, bearer_methods_supported: ["header"], resource_name: "Deeptrack data room" }) };
}

function unauthorized(event: APIGatewayProxyEventV2, status: 401 | 403, message: string): APIGatewayProxyResultV2 {
  const metadata = metadataUrl(event);
  const challenge = status === 401 ? `Bearer resource_metadata="${metadata}", scope="${SCOPES.join(" ")}"` : `Bearer error="insufficient_scope", resource_metadata="${metadata}"`;
  return { statusCode: status, headers: { ...jsonHeaders, "www-authenticate": challenge }, body: JSON.stringify({ error: message }) };
}

// ---- Investor fields as Claude sees them ---------------------------------------
// Brief-style snake_case names → API field names.
const FIELD_MAP = {
  name: "name", organisation: "organisation", email: "email", type: "type", stage: "status", round: "round",
  last_touch_date: "lastContact", last_touch_by: "lastTouchBy", next_step: "nextAction", next_step_date: "nextFollowUp",
  hook: "hook", source_url: "sourceUrl", notes: "notes", tags: "tags",
  priority: "priority", amount_usd_k: "amountTargetK", geography: "geography", website: "website", linkedin: "linkedin", phone: "phone",
} as const;
type McpField = keyof typeof FIELD_MAP;

const str = (description: string, extra: Json = {}) => ({ type: "string", description, ...extra });
const nullable = (schema: Json) => ({ ...schema, type: [schema.type as string, "null"] });
const date = (description: string) => str(`${description} (YYYY-MM-DD)`, { pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const investorRef = str("Which investor: Investor ID (e.g. INV-007), UUID, email, or name (exact or unique partial match).", { minLength: 1 });
const FIELD_SCHEMA: Record<McpField, Json> = {
  name: str("Person or fund contact name.", { minLength: 1, maxLength: 300 }),
  organisation: nullable(str("Fund / firm / organisation.", { maxLength: 300 })),
  email: nullable(str("Email; unique across the pipeline.", { format: "email" })),
  type: nullable({ type: "string", enum: [...TYPES] }),
  stage: { type: "string", enum: [...STATUSES], description: "Only when creating. To change an existing investor's stage use move_stage." },
  round: { type: "string", enum: [...ROUNDS], description: "pre-seed-750k (default) or bridge-100k (Isaak Hayes only)." },
  last_touch_date: nullable(date("Date of the last touch")),
  last_touch_by: nullable({ type: "string", enum: [...TOUCH_BY], description: "Who made the last touch." }),
  next_step: nullable(str("Next step, e.g. 'Send deck v3'.", { maxLength: 4000 })),
  next_step_date: nullable(date("When the next step is due")),
  hook: nullable(str("Why we're contacting them.", { maxLength: 4000 })),
  source_url: nullable(str("Verifiable link backing the hook (https).")),
  notes: nullable(str("Free-form notes. Replaces existing notes; read get_investor first to append.", { maxLength: 4000 })),
  tags: { type: "array", items: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$" }, maxItems: 20, description: "Replaces the tag list, e.g. ['last-nudge-sent']. 'do-not-contact' blocks all writes except move_stage." },
  priority: nullable({ type: "string", enum: ["High", "Medium", "Low"] }),
  amount_usd_k: nullable({ type: "number", minimum: 0, description: "Amount committed or targeted, in $K." }),
  geography: nullable(str("Base / geography.")),
  website: nullable(str("Website.")),
  linkedin: nullable(str("LinkedIn URL.")),
  phone: nullable(str("Phone.")),
};
function toApiFields(args: Json, allowed: readonly McpField[] = Object.keys(FIELD_MAP) as McpField[]) {
  const out: Json = {};
  for (const key of allowed) if (key in args) out[FIELD_MAP[key]] = args[key];
  return out;
}
type InvestorRow = Json & { id: string; ref: string | null; name: string; organisation: string | null; email: string | null; status: string; tags: string[] };
function compact(i: Json) {
  const out: Json = { id: i.id, ref: i.ref };
  for (const [key, field] of Object.entries(FIELD_MAP)) { const v = i[field]; if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) out[key] = v; }
  return out;
}

// ---- Tools -------------------------------------------------------------------

type Tool = { name: string; title: string; description: string; inputSchema: Json; readOnly?: boolean; destructive?: boolean; run: (args: Json, call: Call) => Promise<unknown> };
class ToolError extends Error {}
function ok(result: ApiResult) {
  if (result.status === 429) throw new ToolError(String((result.body as Json)?.error ?? "Rate limited; try again shortly."));
  if (result.status >= 400) throw new ToolError(typeof (result.body as Json)?.error === "string" ? (result.body as Json).error as string : `Request failed (${result.status})`);
  return result.body;
}
const strict = (properties: Json, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

async function allInvestors(call: Call) { return (ok(await call("GET", "/investors")) as { investors: InvestorRow[]; options: Json }); }
async function resolveInvestor(call: Call, ref: unknown): Promise<InvestorRow> {
  const key = String(ref ?? "").trim();
  if (!key) throw new ToolError("Say which investor (Investor ID, UUID, email or name).");
  const { investors } = await allInvestors(call);
  const lower = key.toLowerCase();
  const exact = investors.find((i) => i.id === key || i.ref?.toLowerCase() === lower || i.email?.toLowerCase() === lower || i.name.toLowerCase() === lower);
  if (exact) return exact;
  const partial = investors.filter((i) => `${i.name} ${i.organisation ?? ""}`.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new ToolError(`"${key}" matches ${partial.length} investors: ${partial.slice(0, 10).map((i) => `${i.ref} ${i.name}${i.organisation ? ` (${i.organisation})` : ""}`).join("; ")}. Use the Investor ID.`);
  throw new ToolError(`No investor matches "${key}". Use list_investors to find them, or upsert_investor to add them.`);
}

const TODAY = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(new Date());
const plusDays = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const CSV_COLUMNS = ["name", "organisation", "email", "type", "stage", "last_touch_date", "last_touch_by", "next_step", "next_step_date", "notes", "hook", "source_url", "tags", "round"] as const;

const TOOLS: Tool[] = [
  { name: "whoami", title: "Who am I", description: "Show the signed-in data room role and clearance.", readOnly: true, inputSchema: strict({}),
    run: async (_a, call) => ok(await call("GET", "/access/status")) },

  // Documents
  { name: "list_documents", title: "List documents", description: "List approved data room documents (title, category, clearance tier, status, versions).", readOnly: true, inputSchema: strict({}),
    run: async (_a, call) => ok(await call("GET", "/documents")) },
  { name: "get_document_link", title: "Get document link", description: "Get a short-lived download link (or the external link) for an approved document. Logged in the audit trail.", readOnly: true,
    inputSchema: strict({ documentId: str("Document ID from list_documents.") }, ["documentId"]),
    run: async (a, call) => ok(await call("GET", `/documents/${encodeURIComponent(String(a.documentId))}/download`)) },
  { name: "add_linked_document", title: "Add linked document", description: "Add a document that lives at an HTTPS link (e.g. Google Drive, DocSend). File uploads are done in the web app.",
    inputSchema: strict({ title: str("Plain, specific title, e.g. 'SAFE Note - $750K pre-seed'."), category: { type: "string", enum: [...FOLDER_KEYS], description: "Section / Folder from the data room map." }, tier: { type: "integer", enum: [1, 2, 3], description: "1 General (any investor with access), 2 Diligence (investors upgraded for diligence), 3 Restricted (Founder and Chief of Staff only). Default to 1 unless there is a reason not to." }, version: str("Version label, default 1.0."), link: str("HTTPS URL."), description: str("Optional description.") }, ["title", "category", "tier", "link"]),
    run: async (a, call) => ok(await call("POST", "/documents", { title: a.title, category: a.category, tier: a.tier, version: a.version, link: a.link, description: a.description, source: "link" })) },
  { name: "set_document_status", title: "Set document status", description: "Change a document's status. Only 'approved' documents are visible to investors; 'withdrawn' hides it.", destructive: true,
    inputSchema: strict({ documentId: str("Document ID."), status: { type: "string", enum: ["draft", "review", "approved", "withdrawn"] } }, ["documentId", "status"]),
    run: async (a, call) => ok(await call("POST", `/documents/${encodeURIComponent(String(a.documentId))}/status`, { status: a.status })) },
  { name: "add_document_version", title: "Add document version", description: "Record a new version of a document with a short note on what changed.",
    inputSchema: strict({ documentId: str("Document ID."), note: str("What changed in this version."), version: str("Optional label, e.g. 2.0; defaults to the next minor version.") }, ["documentId", "note"]),
    run: async (a, call) => ok(await call("POST", `/documents/${encodeURIComponent(String(a.documentId))}/versions`, { note: a.note, version: a.version })) },

  // Access
  { name: "list_access_grants", title: "List access grants", description: "List investor access grants: who can see the data room, at which clearance tier, NDA status and expiry.", readOnly: true, inputSchema: strict({}),
    run: async (_a, call) => ok(await call("GET", "/access/grants")) },
  { name: "invite_investor", title: "Invite investor", description: "Give an investor access to the data room by email. They sign in at investors.deeptrack.io with Google using that email, accept the NDA, and then see documents at their tier. Re-inviting an existing investor updates their access.",
    inputSchema: strict({ investorEmail: str("Investor's email (they must sign in with this address)."), firmName: str("Fund or firm name."), clearanceTier: { type: "integer", enum: [1, 2], description: "1 General, 2 Diligence." }, ndaVersion: str("NDA version they must accept, e.g. 2026-11."), expiresAt: str("Access end date (ISO date in the future).") }, ["investorEmail", "clearanceTier", "ndaVersion", "expiresAt"]),
    run: async (a, call) => ok(await call("POST", "/access/grants", a)) },
  { name: "set_investor_tier", title: "Grant diligence / set general", description: "Move an investor between General (1) and Diligence (2) access.",
    inputSchema: strict({ grantId: str("Grant ID from list_access_grants."), clearanceTier: { type: "integer", enum: [1, 2] } }, ["grantId", "clearanceTier"]),
    run: async (a, call) => ok(await call("POST", `/access/grants/${encodeURIComponent(String(a.grantId))}/tier`, { clearanceTier: a.clearanceTier })) },
  { name: "revoke_access", title: "Revoke investor access", description: "Revoke an investor's data room access grant immediately.", destructive: true,
    inputSchema: strict({ grantId: str("Grant ID from list_access_grants.") }, ["grantId"]),
    run: async (a, call) => ok(await call("POST", `/access/grants/${encodeURIComponent(String(a.grantId))}/revoke`)) },
  { name: "audit_log", title: "Audit log", description: "Recent data room audit events (document views and downloads, grants, investor pipeline writes with before → after), newest first.", readOnly: true,
    inputSchema: strict({ limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } }),
    run: async (a, call) => ok(await call("GET", "/audit", undefined, { limit: String(a.limit ?? 100) })) },

  // ---- Investor pipeline: read ----
  { name: "list_investors", title: "List investors", description: "List the private investor pipeline, compact. Filters combine (AND). Paginated: pass next_offset back as offset. Use get_investor for full history.", readOnly: true,
    inputSchema: strict({
      stage: { type: "array", items: { type: "string", enum: [...STATUSES] }, description: "Only these stages." },
      type: { type: "array", items: { type: "string", enum: [...TYPES] }, description: "Only these investor types." },
      round: { type: "string", enum: [...ROUNDS] },
      tag: str("Only investors with this tag, e.g. last-nudge-sent."),
      overdue: { type: "boolean", description: "Only investors whose next step date is before today (Nairobi)." },
      due_within_days: { type: "integer", minimum: 0, maximum: 365, description: "Only investors with a next step due on or before today + N days (overdue included)." },
      search: str("Text to find in name, organisation, email, hook, notes or next step."),
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      offset: { type: "integer", minimum: 0, default: 0 },
    }),
    run: async (a, call) => {
      const { investors } = await allInvestors(call);
      const today = TODAY();
      const search = typeof a.search === "string" ? a.search.trim().toLowerCase() : "";
      const stages = Array.isArray(a.stage) ? a.stage as string[] : undefined;
      const types = Array.isArray(a.type) ? a.type as string[] : undefined;
      const cutoff = typeof a.due_within_days === "number" ? plusDays(today, a.due_within_days) : undefined;
      const rows = investors.filter((i) =>
        (!stages || stages.includes(i.status)) && (!types || types.includes(String(i.type))) && (!a.round || i.round === a.round) &&
        (!a.tag || i.tags.includes(String(a.tag))) &&
        (!a.overdue || (typeof i.nextFollowUp === "string" && i.nextFollowUp < today)) &&
        (!cutoff || (typeof i.nextFollowUp === "string" && i.nextFollowUp <= cutoff)) &&
        (!search || [i.name, i.organisation, i.email, i.hook, i.notes, i.nextAction, i.ref].some((v) => typeof v === "string" && v.toLowerCase().includes(search))));
      const limit = Math.min(Number(a.limit ?? 50), 200); const offset = Number(a.offset ?? 0);
      const page = rows.slice(offset, offset + limit);
      return { total: rows.length, count: page.length, offset, next_offset: offset + limit < rows.length ? offset + limit : null, today, investors: page.map(compact) };
    } },
  { name: "get_investor", title: "Get investor", description: "One investor's full record plus recent activity (emails, calls, meetings, notes, stage changes).", readOnly: true,
    inputSchema: strict({ investor: investorRef, activity_limit: { type: "integer", minimum: 1, maximum: 200, default: 20 } }, ["investor"]),
    run: async (a, call) => {
      const target = await resolveInvestor(call, a.investor);
      const result = ok(await call("GET", `/investors/${target.id}`, undefined, { activityLimit: String(a.activity_limit ?? 20) })) as { investor: Json; activity: Json[] };
      return { investor: compact(result.investor), blocked: result.investor.status === "Banned" || (result.investor.tags as string[]).includes("do-not-contact"), activity: result.activity };
    } },
  { name: "pipeline_summary", title: "Pipeline summary", description: "Snapshot for the daily brief: counts by stage, overdue next steps, meetings in the next 7 days, committed amount (where recorded), stale investors (no touch in 10+ working days) and investors awaiting our reply.", readOnly: true,
    inputSchema: strict({ today: date("Override today's date; defaults to today in Nairobi") }),
    run: async (a, call) => ok(await call("GET", "/investors/summary", undefined, a.today ? { today: String(a.today) } : undefined)) },
  { name: "data_room_activity", title: "Data room activity", description: "Who viewed or downloaded which data room documents since a date, and NDA acceptances, matched to pipeline investors by email.", readOnly: true,
    inputSchema: strict({ since: date("Start date"), include_admins: { type: "boolean", default: false, description: "Include Deeptrack's own views." } }, ["since"]),
    run: async (a, call) => ok(await call("GET", "/investors/data-room-activity", undefined, { since: String(a.since), includeAdmins: String(a.include_admins === true) })) },

  // ---- Investor pipeline: write (only after the user approves) ----
  { name: "upsert_investor", title: "Add or update investor", description: "Create an investor, or update one. Matches an existing investor by `investor` (ID/UUID/email/name) if given, else by email, else by name + organisation. Only the fields you send change; null clears a field. Stage can only be set when creating; use move_stage for existing investors. Refused for Banned or do-not-contact investors.",
    inputSchema: strict({ investor: { ...investorRef, description: "Optional: the existing investor to update." }, ...Object.fromEntries((Object.keys(FIELD_SCHEMA) as McpField[]).filter((k) => k !== "last_touch_date" && k !== "last_touch_by").map((k) => [k, FIELD_SCHEMA[k]])) }),
    run: async (a, call) => {
      const { investors } = await allInvestors(call);
      let target: InvestorRow | undefined;
      if (a.investor !== undefined) target = await resolveInvestor(call, a.investor);
      else if (typeof a.email === "string" && a.email) target = investors.find((i) => i.email?.toLowerCase() === String(a.email).toLowerCase());
      if (!target && a.investor === undefined && typeof a.name === "string") target = investors.find((i) => i.name.toLowerCase() === String(a.name).trim().toLowerCase() && (i.organisation ?? "").toLowerCase() === String(a.organisation ?? "").trim().toLowerCase());
      const fields = toApiFields(a, (Object.keys(FIELD_MAP) as McpField[]).filter((k) => k !== "last_touch_date" && k !== "last_touch_by"));
      if (!target) {
        if (!a.name) throw new ToolError("No matching investor, so this would create one: name is required.");
        return { action: "created", investor: compact(ok(await call("POST", "/investors", fields)) as Json) };
      }
      if ("status" in fields && fields.status !== target.status) throw new ToolError(`${target.name} is already in the pipeline at ${target.status}. Use move_stage to change the stage.`);
      delete fields.status;
      const result = ok(await call("POST", `/investors/${target.id}`, fields)) as { investor: Json; changes: string[] };
      return { action: result.changes.length ? "updated" : "unchanged", investor: compact(result.investor), changes: result.changes };
    } },
  { name: "log_activity", title: "Log email, call, meeting, note, form or intro", description: "Record an interaction with an investor. Updates last_touch_date and last_touch_by (direction in = investor, out = bryan) unless it's a note; can also set the next step. Refused for Banned or do-not-contact investors.",
    inputSchema: strict({ investor: investorRef, type: { type: "string", enum: [...ACTIVITY_KINDS] }, summary: str("What happened, in a sentence or two.", { minLength: 1, maxLength: 4000 }), date: date("When it happened; defaults to today"), direction: { type: "string", enum: ["in", "out"], description: "in = from the investor, out = from us. Default out." }, link: str("Optional https link (email thread, notes, recording)."), next_step: nullable(str("Optional: set the next step at the same time.")), next_step_date: nullable(date("Optional: next step due date")) }, ["investor", "type", "summary"]),
    run: async (a, call) => {
      const target = await resolveInvestor(call, a.investor);
      const body: Json = { kind: a.type, summary: a.summary, date: a.date, direction: a.direction, link: a.link };
      if ("next_step" in a) body.nextStep = a.next_step;
      if ("next_step_date" in a) body.nextStepDate = a.next_step_date;
      const result = ok(await call("POST", `/investors/${target.id}/activity`, body)) as { investor: Json; activity: Json[] };
      return { logged: true, investor: compact(result.investor), latest_activity: result.activity.slice(0, 3) };
    } },
  { name: "move_stage", title: "Move investor stage", description: "Change an investor's pipeline stage. A reason is required for Passed and Banned (and to remove do-not-contact). This is the only change allowed on a Banned or do-not-contact investor.", destructive: true,
    inputSchema: strict({ investor: investorRef, stage: { type: "string", enum: [...STATUSES] }, reason: str("Why. Required for Passed / Banned.", { maxLength: 1000 }), remove_do_not_contact: { type: "boolean", description: "Also remove the do-not-contact tag (needs a reason)." } }, ["investor", "stage"]),
    run: async (a, call) => {
      const target = await resolveInvestor(call, a.investor);
      const result = ok(await call("POST", `/investors/${target.id}/stage`, { stage: a.stage, reason: a.reason, removeDoNotContact: a.remove_do_not_contact === true })) as { investor: Json; changes: string[] };
      return { investor: compact(result.investor), changes: result.changes };
    } },
  { name: "set_next_step", title: "Set next step", description: "Set (or clear with null) an investor's next step and its due date. Refused for Banned or do-not-contact investors.",
    inputSchema: strict({ investor: investorRef, next_step: FIELD_SCHEMA.next_step, next_step_date: FIELD_SCHEMA.next_step_date }, ["investor", "next_step"]),
    run: async (a, call) => {
      const target = await resolveInvestor(call, a.investor);
      const body: Json = { nextAction: a.next_step };
      if ("next_step_date" in a) body.nextFollowUp = a.next_step_date;
      const result = ok(await call("POST", `/investors/${target.id}`, body)) as { investor: Json; changes: string[] };
      return { investor: compact(result.investor), changes: result.changes };
    } },
  { name: "bulk_import", title: "Bulk import investors", description: `Import rows (columns: ${CSV_COLUMNS.join(", ")}). Dry run by default: returns what would be created, updated and why rows conflict, and saves nothing. Call again with commit: true to apply (conflicting rows are skipped). Matches existing investors by email first, then name + organisation. Empty cells never clear data.`,
    inputSchema: strict({
      rows: { type: "array", minItems: 1, maxItems: 500, items: { type: "object", additionalProperties: false, required: ["name"], properties: Object.fromEntries(CSV_COLUMNS.map((c) => [c, c === "tags" ? { type: ["array", "string", "null"], description: "Array or comma-separated." } : { type: ["string", "null"] }])) } },
      commit: { type: "boolean", default: false, description: "false = dry run (default). true = save." },
    }, ["rows"]),
    run: async (a, call) => {
      const rows = (a.rows as Json[]).map((r) => toApiFields(r as Json, CSV_COLUMNS as unknown as McpField[]));
      return ok(await call("POST", "/investors/bulk", { rows, commit: a.commit === true }));
    } },
];

// ---- JSON-RPC --------------------------------------------------------------

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };
const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
export const TOOL_NAMES = TOOLS.map((t) => t.name);

async function dispatch(message: RpcRequest, callFor: (tool: string) => Call, subject: string) {
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize": {
      const requested = String((params as Json).protocolVersion ?? "");
      return rpcResult(id, { protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "deeptrack-data-room", title: "Deeptrack data room", version: "1.1.0" },
        instructions: "Deeptrack's private investor data room and investor pipeline (the single source of truth for fundraising). Read tools are safe to call. Write tools (upsert_investor, log_activity, move_stage, set_next_step, bulk_import with commit, and the document/access tools) change shared records: show the user exactly what you will write and get their approval first. Run bulk_import as a dry run before committing. Banned and do-not-contact investors must not be contacted; only move_stage works on them. Investor records are confidential: do not share them outside Deeptrack." });
    }
    case "ping": return rpcResult(id, {});
    case "tools/list": return rpcResult(id, { tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false } })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === (params as Json).name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String((params as Json).name)}. Tools: ${TOOL_NAMES.join(", ")}`);
      const args = ((params as Json).arguments ?? {}) as Json;
      try {
        const allowed = Object.keys((tool.inputSchema.properties ?? {}) as Json);
        const extra = Object.keys(args).filter((k) => !allowed.includes(k));
        if (extra.length) throw new ToolError(`Unknown argument${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}. ${tool.name} accepts: ${allowed.join(", ") || "no arguments"}.`);
        const missing = ((tool.inputSchema.required ?? []) as string[]).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
        if (missing.length) throw new ToolError(`Missing required argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
        if (!tool.readOnly) await rateLimit(`mcp-write:${subject}`, LIMIT_WRITES_PER_MINUTE);
        const result = await tool.run(args, callFor(tool.name));
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: Array.isArray(result) ? { items: result } : result, isError: false });
      } catch (error) {
        const text = error instanceof ToolError || error instanceof RateLimitError ? error.message : "The data room could not complete that request.";
        if (!(error instanceof ToolError) && !(error instanceof RateLimitError)) console.error("mcp-tool-error", tool.name, error instanceof Error ? error.message : "unknown");
        return rpcResult(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default: return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(event: APIGatewayProxyEventV2, api: Handler): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  if (method !== "POST") return { statusCode: 405, headers: { ...jsonHeaders, allow: "POST" }, body: JSON.stringify({ error: "This MCP server only accepts POST (no SSE stream)." }) };

  const header = event.headers.authorization || event.headers.Authorization;
  if (!header?.startsWith("Bearer ")) return unauthorized(event, 401, "Sign in required");
  let auth: AuthContext;
  const bearer = header.slice(7).trim();
  if (isConnectorToken(bearer)) {
    // Token issued by the data room's own sign-in (Claude added with just the URL).
    const found = await verifyConnectorToken(bearer);
    if (!found) return unauthorized(event, 401, "Sign-in expired or invalid");
    auth = found;
  } else {
    // Auth0 token (connector added with the Auth0 Client ID and secret under Advanced settings).
    try { auth = await requireAuth(event, "any", [mcpResource(event)], { needEmail: true }); }
    catch { return unauthorized(event, 401, "Sign-in expired or invalid"); }
  }
  if (!auth.verifiedEmail || !mcpAllowedEmails().includes(auth.verifiedEmail)) {
    console.warn("mcp-access-denied", auth.subject);
    return unauthorized(event, 403, "This connector is limited to Deeptrack's approved admins. Ask Bryan to add your email to MCP_ALLOWED_EMAILS.");
  }
  // Allow-listed people act as an administrator inside the connector.
  const caller: AuthContext = auth.role === "investor" ? { ...auth, role: "founder", clearanceTier: 3 } : auth;

  try { await rateLimit(`mcp:${caller.subject}`, LIMIT_REQUESTS_PER_MINUTE); }
  catch (error) {
    if (error instanceof RateLimitError) return { statusCode: 429, headers: { ...jsonHeaders, "retry-after": String(error.retryAfterSeconds) }, body: JSON.stringify(rpcError(null, -32000, error.message)) };
    throw error;
  }

  let payload: unknown;
  try { payload = JSON.parse(event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : ""); }
  catch { return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify(rpcError(null, -32700, "Parse error")) }; }

  // Tool calls go through the normal API routes as the verified caller.
  const callFor = (tool: string): Call => async (m, path, body, query) => {
    const inner: APIGatewayProxyEventV2 = { ...event, rawPath: path, rawQueryString: query ? new URLSearchParams(query).toString() : "", queryStringParameters: query, body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false, requestContext: { ...event.requestContext, http: { ...event.requestContext.http, method: m, path } } };
    markMcpCall(inner, { auth: caller, tool });
    const res = await api(inner);
    const r = typeof res === "string" ? { statusCode: 200, body: res } : res;
    let parsed: unknown = undefined; try { parsed = r.body ? JSON.parse(r.body) : undefined; } catch { parsed = r.body; }
    return { status: r.statusCode ?? 200, body: parsed };
  };

  const messages = (Array.isArray(payload) ? payload : [payload]) as RpcRequest[];
  const replies = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || typeof message.method !== "string") { replies.push(rpcError(null, -32600, "Invalid request")); continue; }
    if (message.id === undefined) continue; // notification (e.g. notifications/initialized)
    replies.push(await dispatch(message, callFor, caller.subject));
  }
  if (!replies.length) return { statusCode: 202, headers: jsonHeaders, body: "" };
  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(Array.isArray(payload) ? replies : replies[0]) };
}
