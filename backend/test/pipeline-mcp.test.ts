// Unit tests for the investor pipeline and the MCP connector, against a real
// (embedded) Postgres and a local stand-in for Auth0 (JWKS + /userinfo).
// Run: npm test (from backend/). No network, no AWS, no real investor data.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

const MCP_URL = "https://mcp.test/mcp";
const API_AUDIENCE = "https://api.test/data-room";
const PG_PORT = 55400 + Math.floor(Math.random() * 500);
const EXTRA_ADMIN = "extra.admin@example.test";

let pg: EmbeddedPostgres;
let auth0: Server;
let issuer = "";
let key: KeyLike;
let handler: (e: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;
let pool: import("pg").Pool;
let pipeline: typeof import("../src/pipeline.js");
let investorsMod: typeof import("../src/investors.js");
// The two built-in allow-listed accounts, read from the code (not repeated here).
let OWNER = "";
let OWNER_SECOND = "";

before(async () => {
  pg = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), "dr-pg-")), user: "postgres", password: "test", port: PG_PORT, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await pg.initialise(); await pg.start();

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  key = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
  auth0 = createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); return; }
    if (req.url === "/userinfo") {
      // Echo the token's own email, like Auth0 does for a valid token.
      const token = String(req.headers.authorization ?? "").slice(7);
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}");
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ email: claims["test/email"], email_verified: true })); return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => auth0.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(auth0.address() as { port: number }).port}`;

  Object.assign(process.env, {
    AUTH0_ISSUER: issuer, AUTH0_AUDIENCE: API_AUDIENCE, MCP_RESOURCE_URL: MCP_URL,
    DATABASE_URL: `postgresql://postgres:test@127.0.0.1:${PG_PORT}/postgres`, DATABASE_SSL: "false",
    MCP_ALLOWED_EMAILS: EXTRA_ADMIN, MCP_RATE_LIMIT_PER_MINUTE: "10000", MCP_WRITE_LIMIT_PER_MINUTE: "10000",
  });
  ({ handler } = await import("../src/handler.js") as never);
  pipeline = await import("../src/pipeline.js");
  investorsMod = await import("../src/investors.js");
  pool = (await import("../src/db.js")).getPool();
  [OWNER, OWNER_SECOND] = (await import("../src/auth.js")).mcpAllowedEmails();
});

after(async () => {
  await pool?.end();
  auth0?.close();
  await pg?.stop();
});

// ---- helpers -----------------------------------------------------------------

async function token(email: string, { audience = MCP_URL, inToken = true, roles = [] as string[] } = {}) {
  return new SignJWT({ ...(inToken ? { email, email_verified: true } : {}), "test/email": email, "https://deeptrack.io/roles": roles })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).setSubject(`google-oauth2|${email}`).setIssuer(`${issuer}/`).setAudience(audience)
    .setIssuedAt().setExpirationTime("10m").sign(key);
}
function event(method: string, path: string, { bearer, body, query }: { bearer?: string; body?: unknown; query?: Record<string, string> } = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0", routeKey: "$default", rawPath: path, rawQueryString: query ? new URLSearchParams(query).toString() : "", queryStringParameters: query,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), "user-agent": "node-test" },
    body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false,
    requestContext: { accountId: "test", apiId: "test", domainName: "mcp.test", domainPrefix: "mcp", requestId: "r", routeKey: "$default", stage: "$default", time: "", timeEpoch: 0,
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "node-test" } },
  } as APIGatewayProxyEventV2;
}
let rpcId = 0;
async function rpc(bearer: string | undefined, method: string, params: unknown = {}) {
  const res = await handler(event("POST", "/mcp", { bearer, body: { jsonrpc: "2.0", id: ++rpcId, method, params } }));
  return { status: res.statusCode, headers: res.headers ?? {}, body: res.body ? JSON.parse(res.body) : undefined };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolResult = { isError: boolean; text: string; data: any };
async function tool(bearer: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const r = await rpc(bearer, "tools/call", { name, arguments: args });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const result = r.body.result;
  const text = result.content[0].text as string;
  return { isError: result.isError, text, data: result.isError ? undefined : JSON.parse(text) };
}
async function okTool(bearer: string, name: string, args: Record<string, unknown> = {}) {
  const r = await tool(bearer, name, args);
  assert.equal(r.isError, false, `${name} failed: ${r.text}`);
  return r.data;
}
async function lastAudit(eventName: string) {
  const r = await pool.query("SELECT * FROM data_room_audit_events WHERE event=$1 ORDER BY created_at DESC LIMIT 1", [eventName]);
  return r.rows[0];
}

// ---- tests -------------------------------------------------------------------

describe("auth", () => {
  test("the built-in allow-list has the two approved accounts", () => {
    assert.ok(OWNER.endsWith("@deeptrack.io")); assert.ok(OWNER_SECOND.endsWith("@gmail.com"));
  });
  test("no token: 401 pointing at the protected-resource metadata", async () => {
    const r = await rpc(undefined, "tools/list");
    assert.equal(r.status, 401);
    assert.match(String(r.headers["www-authenticate"]), /resource_metadata="https:\/\/mcp\.test\/\.well-known\/oauth-protected-resource"/);
  });
  test("token for another audience is refused", async () => {
    const r = await rpc(await token(OWNER, { audience: "https://elsewhere.test" }), "tools/list");
    assert.equal(r.status, 401);
  });
  test("verified email outside the allow-list is refused (403), even an Investor Relations admin", async () => {
    assert.equal((await rpc(await token("someone@fund.example"), "tools/list")).status, 403);
    assert.equal((await rpc(await token("ir.admin@example.test", { roles: ["investorRelations"] }), "tools/list")).status, 403);
  });
  test("both built-in accounts and MCP_ALLOWED_EMAILS are allowed", async () => {
    for (const email of [OWNER, OWNER_SECOND, EXTRA_ADMIN]) assert.equal((await rpc(await token(email), "tools/list")).status, 200, email);
  });
  test("email is confirmed through /userinfo when the token has no email claim", async () => {
    assert.equal((await rpc(await token(OWNER_SECOND, { inToken: false }), "tools/list")).status, 200);
    assert.equal((await rpc(await token("intruder@example.com", { inToken: false }), "tools/list")).status, 403);
  });
  test("a non-admin cannot reach the pipeline API directly with a web token", async () => {
    const res = await handler(event("GET", "/investors", { bearer: await token("someone@fund.example", { audience: API_AUDIENCE }) }));
    assert.equal(res.statusCode, 403);
  });
});

describe("MCP tools", () => {
  let me: string;
  before(async () => { me = await token(OWNER); });

  test("tools/list has every pipeline tool with a strict schema", async () => {
    const r = await rpc(me, "tools/list");
    const tools = r.body.result.tools as { name: string; inputSchema: { additionalProperties?: boolean } }[];
    for (const name of ["list_investors", "get_investor", "pipeline_summary", "data_room_activity", "upsert_investor", "log_activity", "move_stage", "set_next_step", "bulk_import"]) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, name);
      assert.equal(t.inputSchema.additionalProperties, false, `${name} schema is strict`);
    }
  });

  test("unknown and missing arguments get errors that say what to fix", async () => {
    const extra = await tool(me, "get_investor", { investor: "x", colour: "red" });
    assert.equal(extra.isError, true); assert.match(extra.text, /Unknown argument: colour/);
    const missing = await tool(me, "log_activity", { investor: "x" });
    assert.equal(missing.isError, true); assert.match(missing.text, /Missing required arguments: type, summary/);
  });

  test("upsert_investor creates, then updates by email; stage changes need move_stage", async () => {
    const created = await okTool(me, "upsert_investor", { name: "Ada Test", organisation: "Test Ventures", email: "Ada@TestVentures.example", type: "VC", stage: "Contacted", hook: "Invests in trust infrastructure", source_url: "https://example.com/post", tags: ["warm"] });
    assert.equal(created.action, "created");
    assert.equal(created.investor.email, "ada@testventures.example");
    assert.equal(created.investor.round, "pre-seed-750k");
    assert.equal(created.investor.stage, "Contacted");

    const updated = await okTool(me, "upsert_investor", { email: "ada@testventures.example", next_step: "Send deck", next_step_date: "2026-11-25" });
    assert.equal(updated.action, "updated");
    assert.equal(updated.investor.ref, created.investor.ref);
    assert.deepEqual(updated.changes, ["Next step: blank → Send deck", "Next step date: blank → 2026-11-25"]);

    const stage = await tool(me, "upsert_investor", { investor: created.investor.ref, stage: "Replied" });
    assert.equal(stage.isError, true); assert.match(stage.text, /Use move_stage/);

    const badType = await tool(me, "upsert_investor", { name: "Bad Type", type: "Family office" });
    assert.equal(badType.isError, true); assert.match(badType.text, /Type must be one of: VC, Angel/);

    const same = await tool(me, "upsert_investor", { investor: created.investor.ref, email: "ADA@testventures.example" });
    assert.equal(same.isError, false);
    await okTool(me, "upsert_investor", { name: "Other Person", organisation: "Elsewhere", email: "other@elsewhere.example", stage: "Contacted" });
    const clash = await tool(me, "upsert_investor", { investor: "Other Person", email: "ada@testventures.example" });
    assert.equal(clash.isError, true); assert.match(clash.text, /already belongs to Ada Test/);
  });

  test("bridge-100k is only for Isaak Hayes", async () => {
    const wrong = await tool(me, "upsert_investor", { name: "Someone Else", round: "bridge-100k" });
    assert.equal(wrong.isError, true); assert.match(wrong.text, /only for Isaak Hayes/);
    const right = await okTool(me, "upsert_investor", { name: "Isaak Hayes", type: "Angel", stage: "Committed", round: "bridge-100k", amount_usd_k: 100 });
    assert.equal(right.investor.round, "bridge-100k");
  });

  test("log_activity records the touch, sets the next step, and shows in the web app's investor view and the audit log", async () => {
    const r = await okTool(me, "log_activity", { investor: "Ada Test", type: "email", summary: "She replied asking for the deck", direction: "in", date: "2026-11-20", link: "https://mail.example/thread/1", next_step: "Reply with deck v3", next_step_date: "2026-11-21" });
    assert.equal(r.investor.last_touch_date, "2026-11-20");
    assert.equal(r.investor.last_touch_by, "investor");
    assert.equal(r.investor.next_step, "Reply with deck v3");

    // The data room's own admin view (the API the web app's Investors screen calls).
    const web = await token(OWNER, { audience: API_AUDIENCE });
    const list = JSON.parse(String((await handler(event("GET", "/investors", { bearer: web }))).body));
    const ada = list.investors.find((i: { name: string }) => i.name === "Ada Test");
    const detail = JSON.parse(String((await handler(event("GET", `/investors/${ada.id}`, { bearer: web }))).body));
    const logged = detail.activity.find((a: { kind: string }) => a.kind === "email");
    assert.equal(logged.summary, "She replied asking for the deck");
    assert.equal(logged.direction, "in");
    assert.equal(logged.link, "https://mail.example/thread/1");

    const audit = await lastAudit("investor_activity_logged");
    assert.equal(audit.actor_email, OWNER);
    const d = JSON.parse(audit.detail);
    assert.equal(d.via, "mcp"); assert.equal(d.tool, "log_activity"); assert.equal(d.investor, ada.ref);
    assert.deepEqual(d.changes.find((c: { field: string }) => c.field === "lastTouchBy"), { field: "lastTouchBy", before: "null", after: "investor" });
  });

  test("a note does not count as a touch; an older email does not move last touch back", async () => {
    await okTool(me, "log_activity", { investor: "Ada Test", type: "note", summary: "Prefers WhatsApp" });
    const older = await okTool(me, "log_activity", { investor: "Ada Test", type: "call", summary: "Old call", date: "2026-10-01" });
    assert.equal(older.investor.last_touch_date, "2026-11-20");
  });

  test("move_stage needs a reason for Passed and Banned, and is audited before → after", async () => {
    const noReason = await tool(me, "move_stage", { investor: "Other Person", stage: "Passed" });
    assert.equal(noReason.isError, true); assert.match(noReason.text, /reason is required/);
    const moved = await okTool(me, "move_stage", { investor: "Other Person", stage: "Passed", reason: "Not investing this year" });
    assert.equal(moved.investor.stage, "Passed");
    assert.match(moved.changes[0], /Reason: Not investing this year/);
    const d = JSON.parse((await lastAudit("investor_stage_changed")).detail);
    assert.deepEqual(d.changes[0], { field: "status", before: "Contacted", after: "Passed" });
    assert.equal(d.reason, "Not investing this year");
  });

  test("Banned and do-not-contact investors refuse every write except move_stage", async () => {
    await okTool(me, "upsert_investor", { name: "Banned Person", organisation: "Spam Partners", email: "spam@partners.example", stage: "Banned" });
    for (const [name, args] of [
      ["log_activity", { investor: "Banned Person", type: "email", summary: "hi" }],
      ["set_next_step", { investor: "Banned Person", next_step: "Follow up" }],
      ["upsert_investor", { investor: "Banned Person", notes: "x" }],
      ["upsert_investor", { email: "spam@partners.example", hook: "x" }],
    ] as const) {
      const r = await tool(me, name, args);
      assert.equal(r.isError, true, name); assert.match(r.text, /is Banned, so .* is refused/, name);
    }
    const bulk = await okTool(me, "bulk_import", { rows: [{ name: "Banned Person", organisation: "Spam Partners", email: "spam@partners.example", notes: "new" }] });
    assert.equal(bulk.conflicts, 1); assert.match(bulk.rows[0].reason, /is Banned/);

    await okTool(me, "upsert_investor", { name: "Quiet Person", tags: ["do-not-contact"] });
    const dnc = await tool(me, "log_activity", { investor: "Quiet Person", type: "call", summary: "x" });
    assert.equal(dnc.isError, true); assert.match(dnc.text, /tagged do-not-contact/);

    const lift = await tool(me, "move_stage", { investor: "Quiet Person", stage: "Contacted", remove_do_not_contact: true });
    assert.equal(lift.isError, true); assert.match(lift.text, /reason is required/);
    const unban = await okTool(me, "move_stage", { investor: "Banned Person", stage: "Reconnect later", reason: "Cleared" });
    assert.equal(unban.investor.stage, "Reconnect later");
  });

  test("bulk_import: dry run saves nothing; commit applies creates and updates; conflicts are reported", async () => {
    const count = async () => (await pool.query("SELECT count(*)::int AS n FROM data_room_investors")).rows[0].n as number;
    const start = await count();
    const rows = [
      { name: "New Angel", organisation: "Solo", email: "new@angel.example", type: "Angel", stage: "Contacted", last_touch_date: "2026-11-18", last_touch_by: "bryan", next_step: "Nudge", next_step_date: "2026-11-24", notes: "From the list" },
      { name: "Ada Test", organisation: "Test Ventures", email: "ada@testventures.example", notes: "Met at a demo day" },
      { name: "Bad Stage", stage: "Maybe" },
      { name: "New Angel", organisation: "Solo", email: "new@angel.example" },
      { name: "Ada Test", organisation: "Test Ventures", email: "other@elsewhere.example" },
    ];
    const dry = await okTool(me, "bulk_import", { rows });
    assert.equal(dry.committed, false);
    assert.deepEqual([dry.creates, dry.updates, dry.conflicts], [1, 1, 3]);
    assert.equal(dry.rows[1].matchedBy, "email");
    assert.match(dry.rows[2].reason, /Stage must be one of/);
    assert.match(dry.rows[3].reason, /Duplicate of an earlier row/);
    assert.match(dry.rows[4].reason, /Email matches Other Person .* but name \+ organisation match Ada Test/);
    assert.equal(await count(), start, "dry run saved nothing");

    const done = await okTool(me, "bulk_import", { rows, commit: true });
    assert.deepEqual([done.creates, done.updates, done.conflicts], [1, 1, 3]);
    assert.equal(await count(), start + 1);
    const angel = await okTool(me, "get_investor", { investor: "new@angel.example" });
    assert.equal(angel.investor.last_touch_by, "bryan"); assert.equal(angel.investor.next_step_date, "2026-11-24");
    assert.ok((await lastAudit("investors_bulk_imported")).detail.includes('"tool":"bulk_import"'));

    const again = await okTool(me, "bulk_import", { rows: rows.slice(0, 2) });
    assert.deepEqual([again.creates, again.updates, again.unchanged], [0, 0, 2]);
  });

  test("list_investors filters and paginates", async () => {
    const all = await okTool(me, "list_investors", { limit: 2 });
    assert.equal(all.count, 2); assert.equal(all.next_offset, 2); assert.ok(all.total >= 5);
    const angels = await okTool(me, "list_investors", { type: ["Angel"] });
    assert.deepEqual(angels.investors.map((i: { name: string }) => i.name).sort(), ["Isaak Hayes", "New Angel"]);
    const search = await okTool(me, "list_investors", { search: "demo day" });
    assert.deepEqual(search.investors.map((i: { name: string }) => i.name), ["Ada Test"]);
    const due = await okTool(me, "list_investors", { due_within_days: 30, stage: ["Contacted"] });
    assert.ok(due.investors.length > 0);
    assert.ok(due.investors.every((i: { stage: string; next_step_date?: string }) => i.stage === "Contacted" && i.next_step_date));
  });

  test("pipeline_summary returns stage counts, overdue, committed, stale and awaiting reply", async () => {
    const s = await okTool(me, "pipeline_summary", { today: "2026-12-10" });
    assert.equal(s.today, "2026-12-10");
    assert.equal(s.by_stage.Committed, 1);
    assert.equal(s.committed.amount_usd_k_recorded, 100);
    assert.ok(s.overdue_next_steps.some((o: { name: string }) => o.name === "Ada Test"));
    assert.ok(s.stale.investors.some((o: { name: string }) => o.name === "New Angel"));
    assert.ok(s.awaiting_our_reply.some((o: { name: string }) => o.name === "Ada Test"));
  });

  test("data_room_activity matches document views and NDA acceptances to investors by email", async () => {
    const doc = await pool.query("INSERT INTO data_room_documents (id,title,category,tier,source,link,owner_subject,status,created_at,updated_at) VALUES (gen_random_uuid(),'Pitch deck','01-company/01-overview',1,'link','https://example.com/deck','x','approved',now(),now()) RETURNING id");
    await pool.query("INSERT INTO data_room_audit_events (event_id,event,actor_subject,actor_email,document_id,created_at) VALUES (gen_random_uuid(),'nda_acknowledged','google|ada','ada@testventures.example',NULL,'2026-11-19T09:00:00Z'), (gen_random_uuid(),'document_viewed','google|ada','ada@testventures.example',$1,'2026-11-19T09:05:00Z'), (gen_random_uuid(),'document_viewed','google|old','old@viewer.example',$1,'2026-10-01T09:05:00Z')", [doc.rows[0].id]);
    const a = await okTool(me, "data_room_activity", { since: "2026-11-01" });
    assert.equal(a.people, 1);
    assert.equal(a.viewers[0].investor.name, "Ada Test");
    assert.deepEqual(a.viewers[0].documents, ["Pitch deck"]);
    assert.equal(a.nda_acceptances.length, 1);
  });
});

describe("audit log and limits", () => {
  test("audit events are append-only", async () => {
    await assert.rejects(pool.query("UPDATE data_room_audit_events SET detail='x'"), /append-only/);
    await assert.rejects(pool.query("DELETE FROM data_room_audit_events"), /append-only/);
  });
  test("rate limit refuses past the limit with a retry time", async () => {
    const k = `test:${Math.random()}`;
    for (let i = 0; i < 3; i++) await pipeline.rateLimit(k, 3);
    await assert.rejects(pipeline.rateLimit(k, 3), (e: unknown) => e instanceof pipeline.RateLimitError && e.retryAfterSeconds >= 1);
  });
});

describe("migration of the old stage list", () => {
  test("old stages, rounds and Do not contact are mapped and recorded", async () => {
    const ins = async (name: string, status: string, deck: string | null = null, round: string | null = null) =>
      (await pool.query("INSERT INTO data_room_investors (name, status, deck_sent, round, created_by_subject) VALUES ($1,$2,$3,$4,'t') RETURNING id", [name, status, deck, round])).rows[0].id as string;
    const waiting = await ins("Legacy Waiting", "Waiting reply", "Yes", "Seed");
    const dnc = await ins("Legacy DNC", "Do not contact");
    const ts = await ins("Legacy Term", "Term sheet");
    await pool.query(investorsMod.MIGRATION_V2);
    await pool.query(investorsMod.MIGRATION_V2); // idempotent
    const get = async (id: string) => (await pool.query("SELECT status, tags, round, notes FROM data_room_investors WHERE id=$1", [id])).rows[0];
    assert.deepEqual(await get(waiting), { status: "Deck sent", tags: [], round: "pre-seed-750k", notes: "Round (before Nov 2026): Seed" });
    assert.equal((await get(dnc)).status, "Banned");
    assert.deepEqual((await get(dnc)).tags, ["do-not-contact"]);
    assert.equal((await get(ts)).status, "Committed");
    const logged = await pool.query("SELECT summary FROM data_room_investor_activity WHERE investor_id=$1", [waiting]);
    assert.deepEqual(logged.rows.map((r) => r.summary), ["Stage: Waiting reply → Deck sent (new stage list, Nov 2026)"]);
  });
});

describe("pure helpers", () => {
  test("working days skip weekends", () => {
    assert.equal(pipeline.workingDaysBetween("2026-11-20", "2026-11-23"), 1); // Fri → Mon
    assert.equal(pipeline.workingDaysBetween("2026-11-06", "2026-11-20"), 10);
  });
  test("stale uses 10 working days and ignores closed stages", () => {
    const s = pipeline.summarisePipeline([
      { ref: "A", name: "A", status: "Contacted", lastContact: "2026-11-06", tags: [] },
      { ref: "B", name: "B", status: "Contacted", lastContact: "2026-11-09", tags: [] },
      { ref: "C", name: "C", status: "Passed", lastContact: "2026-01-01", tags: [] },
    ], "2026-11-20");
    assert.deepEqual(s.stale.investors.map((i) => i.ref), ["A"]);
  });
});
