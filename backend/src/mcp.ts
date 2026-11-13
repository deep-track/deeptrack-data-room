// Remote MCP server for the data room (Streamable HTTP, stateless JSON replies).
// Claude signs in through Auth0 like the web app, and only Founder and Investor
// Relations accounts may use it. Every tool runs through the same API route the
// web app uses, so validation, clearance checks and the audit log are identical.
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { authIssuer, requireAuth } from "./auth.js";
import { INVESTOR_FIELDS } from "./investors.js";
import { FOLDER_KEYS } from "./taxonomy.js";

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;
type Json = Record<string, unknown>;
type ApiResult = { status: number; body: unknown };
type Call = (method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string>) => Promise<ApiResult>;

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SCOPES = ["openid", "profile", "email"];
const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store" };

export function publicBase(event: APIGatewayProxyEventV2) { return `https://${event.requestContext.domainName}`; }
export function mcpResource(event: APIGatewayProxyEventV2) { return process.env.MCP_RESOURCE_URL?.trim() || `${publicBase(event)}/mcp`; }

// RFC 9728 protected-resource metadata: tells Claude to sign in with Auth0.
export function protectedResourceMetadata(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 {
  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ resource: mcpResource(event), authorization_servers: [authIssuer()], scopes_supported: SCOPES, bearer_methods_supported: ["header"], resource_name: "Deeptrack data room" }) };
}

function unauthorized(event: APIGatewayProxyEventV2, status: 401 | 403, message: string): APIGatewayProxyResultV2 {
  const metadata = `${publicBase(event)}/.well-known/oauth-protected-resource`;
  const challenge = status === 401 ? `Bearer resource_metadata="${metadata}", scope="${SCOPES.join(" ")}"` : `Bearer error="insufficient_scope", resource_metadata="${metadata}"`;
  return { statusCode: status, headers: { ...jsonHeaders, "www-authenticate": challenge }, body: JSON.stringify({ error: message }) };
}

// ---- Tools -----------------------------------------------------------------

const str = (description: string, extra: Json = {}) => ({ type: "string", description, ...extra });
const investorRef = str("Investor UUID, Investor ID (e.g. INV-007) or name (exact or unique partial match).");
const investorFieldProps: Json = Object.fromEntries(INVESTOR_FIELDS.map((f) => [f.name, f.choices ? { type: ["string", "null"], enum: [...f.choices, null], description: f.label } : f.kind === "number" || f.kind === "percent" ? { type: ["number", "null"], description: f.label + (f.kind === "percent" ? " (0-100)" : "") } : { type: ["string", "null"], description: f.label + (f.kind === "date" ? " (YYYY-MM-DD)" : "") }]));

type Tool = { name: string; title: string; description: string; inputSchema: Json; readOnly?: boolean; destructive?: boolean; run: (args: Json, call: Call) => Promise<unknown> };

function ok(result: ApiResult) {
  if (result.status >= 400) throw new ToolError(typeof (result.body as Json)?.error === "string" ? (result.body as Json).error as string : `Request failed (${result.status})`);
  return result.body;
}
class ToolError extends Error {}

type InvestorRow = Json & { id: string; ref: string | null; name: string; status: string; priority: string | null; nextFollowUp: string | null; nextAction: string | null; lastContact: string | null; type: string | null };

async function allInvestors(call: Call) { return (ok(await call("GET", "/investors")) as { investors: InvestorRow[]; options: Json }); }
async function resolveInvestor(call: Call, ref: unknown): Promise<InvestorRow> {
  const key = String(ref ?? "").trim();
  if (!key) throw new ToolError("Say which investor (UUID, Investor ID or name).");
  const { investors } = await allInvestors(call);
  const lower = key.toLowerCase();
  const exact = investors.find((i) => i.id === key || i.ref?.toLowerCase() === lower || i.name.toLowerCase() === lower);
  if (exact) return exact;
  const partial = investors.filter((i) => i.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new ToolError(`"${key}" matches ${partial.length} investors: ${partial.slice(0, 10).map((i) => `${i.ref} ${i.name}`).join("; ")}. Use the Investor ID.`);
  throw new ToolError(`No investor matches "${key}".`);
}
function summary(i: InvestorRow) { return { id: i.id, ref: i.ref, name: i.name, type: i.type, status: i.status, priority: i.priority, lastContact: i.lastContact, nextAction: i.nextAction, nextFollowUp: i.nextFollowUp }; }
function fieldsOnly(args: Json) { const out: Json = {}; for (const f of INVESTOR_FIELDS) if (f.name in args) out[f.name] = args[f.name]; return out; }

const TOOLS: Tool[] = [
  { name: "whoami", title: "Who am I", description: "Show the signed-in data room role and clearance.", readOnly: true, inputSchema: { type: "object", properties: {} },
    run: async (_a, call) => ok(await call("GET", "/access/status")) },

  // Documents
  { name: "list_documents", title: "List documents", description: "List approved data room documents (title, category, clearance tier, status, versions).", readOnly: true, inputSchema: { type: "object", properties: {} },
    run: async (_a, call) => ok(await call("GET", "/documents")) },
  { name: "get_document_link", title: "Get document link", description: "Get a short-lived download link (or the external link) for an approved document. Logged in the audit trail.", readOnly: true,
    inputSchema: { type: "object", properties: { documentId: str("Document ID from list_documents.") }, required: ["documentId"] },
    run: async (a, call) => ok(await call("GET", `/documents/${encodeURIComponent(String(a.documentId))}/download`)) },
  { name: "add_linked_document", title: "Add linked document", description: "Add a document that lives at an HTTPS link (e.g. Google Drive, DocSend). File uploads are done in the web app.",
    inputSchema: { type: "object", properties: { title: str("Plain, specific title, e.g. 'SAFE Note - $750K pre-seed'."), category: { type: "string", enum: [...FOLDER_KEYS], description: "Section / Folder from the data room map." }, tier: { type: "integer", enum: [1, 2, 3], description: "1 General (any investor with access), 2 Diligence (investors upgraded for diligence), 3 Restricted (Founder and Chief of Staff only). Default to 1 unless there is a reason not to." }, version: str("Version label, default 1.0."), link: str("HTTPS URL."), description: str("Optional description.") }, required: ["title", "category", "tier", "link"] },
    run: async (a, call) => ok(await call("POST", "/documents", { title: a.title, category: a.category, tier: a.tier, version: a.version, link: a.link, description: a.description, source: "link" })) },
  { name: "set_document_status", title: "Set document status", description: "Change a document's status. Only 'approved' documents are visible to investors; 'withdrawn' hides it.", destructive: true,
    inputSchema: { type: "object", properties: { documentId: str("Document ID."), status: { type: "string", enum: ["draft", "review", "approved", "withdrawn"] } }, required: ["documentId", "status"] },
    run: async (a, call) => ok(await call("POST", `/documents/${encodeURIComponent(String(a.documentId))}/status`, { status: a.status })) },
  { name: "add_document_version", title: "Add document version", description: "Record a new version of a document with a short note on what changed.",
    inputSchema: { type: "object", properties: { documentId: str("Document ID."), note: str("What changed in this version."), version: str("Optional label, e.g. 2.0; defaults to the next minor version.") }, required: ["documentId", "note"] },
    run: async (a, call) => ok(await call("POST", `/documents/${encodeURIComponent(String(a.documentId))}/versions`, { note: a.note, version: a.version })) },

  // Access
  { name: "list_access_grants", title: "List access grants", description: "List investor access grants: who can see the data room, at which clearance tier, NDA status and expiry.", readOnly: true, inputSchema: { type: "object", properties: {} },
    run: async (_a, call) => ok(await call("GET", "/access/grants")) },
  { name: "grant_access", title: "Grant investor access", description: "Give an investor access to the data room (or update their grant). They must accept the NDA version before seeing documents.",
    inputSchema: { type: "object", properties: { investorSubject: str("The investor's Auth0 user ID (e.g. google-oauth2|123...)."), investorEmail: str("Investor's email."), firmName: str("Fund or firm name."), clearanceTier: { type: "integer", enum: [1, 2, 3] }, ndaVersion: str("NDA version they must accept, e.g. 2026-11."), expiresAt: str("Expiry, ISO date/time in the future.") }, required: ["investorSubject", "investorEmail", "clearanceTier", "ndaVersion", "expiresAt"] },
    run: async (a, call) => ok(await call("POST", "/access/grants", a)) },
  { name: "revoke_access", title: "Revoke investor access", description: "Revoke an investor's data room access grant immediately.", destructive: true,
    inputSchema: { type: "object", properties: { grantId: str("Grant ID from list_access_grants.") }, required: ["grantId"] },
    run: async (a, call) => ok(await call("POST", `/access/grants/${encodeURIComponent(String(a.grantId))}/revoke`)) },
  { name: "audit_log", title: "Audit log", description: "Recent data room audit events (sign-ins to documents, downloads, grants, changes), newest first.", readOnly: true,
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } } },
    run: async (a, call) => ok(await call("GET", "/audit", undefined, { limit: String(a.limit ?? 100) })) },

  // Investor pipeline
  { name: "list_investors", title: "List investors", description: "List the private investor pipeline with optional filters. Returns a compact summary per investor; use get_investor for full details and history.", readOnly: true,
    inputSchema: { type: "object", properties: { status: str("Only this stage, e.g. 'Waiting reply'."), priority: { type: "string", enum: ["High", "Medium", "Low"] }, search: str("Text to find in name, type, geography, thesis or notes."), followUpWithinDays: { type: "integer", minimum: 0, description: "Only investors with a next follow-up on or before today + N days (overdue included)." } } },
    run: async (a, call) => {
      const { investors, options } = await allInvestors(call);
      const search = typeof a.search === "string" ? a.search.toLowerCase() : "";
      const cutoff = typeof a.followUpWithinDays === "number" ? new Date(Date.now() + a.followUpWithinDays * 86400000).toISOString().slice(0, 10) : undefined;
      const rows = investors.filter((i) =>
        (!a.status || i.status.toLowerCase() === String(a.status).toLowerCase()) &&
        (!a.priority || i.priority === a.priority) &&
        (!search || [i.name, i.type, i.geography, i.sectorFocus, i.stageFocus, i.notes, i.introAngle].some((v) => typeof v === "string" && v.toLowerCase().includes(search))) &&
        (!cutoff || (i.nextFollowUp !== null && i.nextFollowUp <= cutoff)));
      return { count: rows.length, total: investors.length, stages: options.statuses, investors: rows.map(summary) };
    } },
  { name: "get_investor", title: "Get investor", description: "Full record and activity history for one investor.", readOnly: true,
    inputSchema: { type: "object", properties: { investor: investorRef }, required: ["investor"] },
    run: async (a, call) => ok(await call("GET", `/investors/${(await resolveInvestor(call, a.investor)).id}`)) },
  { name: "create_investor", title: "Add investor", description: "Add an investor to the pipeline. Only name is required; stage defaults to 'Not started'.",
    inputSchema: { type: "object", properties: investorFieldProps, required: ["name"] },
    run: async (a, call) => ok(await call("POST", "/investors", fieldsOnly(a))) },
  { name: "update_investor", title: "Update investor", description: "Change fields on an investor (stage, priority, next action, follow-up date, notes...). Only the fields given are changed; null clears a field. Each change is recorded in the investor's history.",
    inputSchema: { type: "object", properties: { investor: investorRef, ...investorFieldProps }, required: ["investor"] },
    run: async (a, call) => { const target = await resolveInvestor(call, a.investor); const { investor: _ignored, ...rest } = a; return ok(await call("POST", `/investors/${target.id}`, fieldsOnly(rest))); } },
  { name: "log_investor_activity", title: "Log meeting, call, email or note", description: "Record an interaction with an investor. Meetings, calls and emails also update their last-contact date.",
    inputSchema: { type: "object", properties: { investor: investorRef, kind: { type: "string", enum: ["meeting", "call", "email", "note"] }, summary: str("What happened."), date: str("YYYY-MM-DD; defaults to today.") }, required: ["investor", "kind", "summary"] },
    run: async (a, call) => { const target = await resolveInvestor(call, a.investor); return ok(await call("POST", `/investors/${target.id}/activity`, { kind: a.kind, summary: a.summary, ...(a.date ? { date: a.date } : {}) })); } },
];

// ---- JSON-RPC --------------------------------------------------------------

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };
const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function dispatch(message: RpcRequest, call: Call) {
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize": {
      const requested = String((params as Json).protocolVersion ?? "");
      return rpcResult(id, { protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "deeptrack-data-room", title: "Deeptrack data room", version: "1.0.0" },
        instructions: "Deeptrack's private investor data room. Founder and Investor Relations only. Documents, investor access grants, the audit log and the private investor pipeline. Investor records are confidential: do not share them outside Deeptrack. Confirm with the user before revoking access, withdrawing documents or changing investor stages." });
    }
    case "ping": return rpcResult(id, {});
    case "tools/list": return rpcResult(id, { tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false } })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === (params as Json).name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String((params as Json).name)}`);
      const args = ((params as Json).arguments ?? {}) as Json;
      try {
        const result = await tool.run(args, call);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: Array.isArray(result) ? { items: result } : result, isError: false });
      } catch (error) {
        const text = error instanceof ToolError ? error.message : "The data room could not complete that request.";
        if (!(error instanceof ToolError)) console.error("mcp-tool-error", tool.name, error instanceof Error ? error.message : "unknown");
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
  try { await requireAuth(event, "admin", [mcpResource(event)]); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    return /Administrator role required/.test(message) ? unauthorized(event, 403, "Only Founder and Investor Relations can use the data room connector") : unauthorized(event, 401, "Sign-in expired or invalid");
  }

  let payload: unknown;
  try { payload = JSON.parse(event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : ""); }
  catch { return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify(rpcError(null, -32700, "Parse error")) }; }

  // Tool calls go through the normal API routes with the caller's own token.
  const call: Call = async (m, path, body, query) => {
    const inner: APIGatewayProxyEventV2 = { ...event, rawPath: path, rawQueryString: query ? new URLSearchParams(query).toString() : "", queryStringParameters: query, body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false, requestContext: { ...event.requestContext, http: { ...event.requestContext.http, method: m, path } } };
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
    replies.push(await dispatch(message, call));
  }
  if (!replies.length) return { statusCode: 202, headers: jsonHeaders, body: "" };
  return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(Array.isArray(payload) ? replies : replies[0]) };
}
