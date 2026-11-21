// OAuth 2.1 authorization server for the Claude connector, so adding the data
// room in Claude needs only the URL (like the Deeptrack CRM): Claude registers
// itself (RFC 7591), the person signs in with Google through Auth0 (the web app's
// own login, PKCE, no client secret), and the data room issues its own tokens.
// Only allow-listed emails get a code. Codes and tokens are stored as SHA-256 hashes.
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getPool, insertAudit, query, withTransaction } from "./db.js";
import { authIssuer, mcpAllowedEmails } from "./auth.js";
import type { AuthContext } from "./types.js";

export const SCOPE = "data-room";
const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL = 5 * 60;
const LOGIN_TTL = 10 * 60;
// The web app's Auth0 client (public, PKCE). Its Allowed Callback URLs must include <base>/oauth/callback.
const loginClientId = () => process.env.AUTH0_LOGIN_CLIENT_ID?.trim() || "2nsfWPfcCPkxA3N7Me4aUwjlSsDeoFbM";

const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");
const random = (bytes = 32) => randomBytes(bytes).toString("base64url");
const noStore = { "cache-control": "no-store", pragma: "no-cache" };
const json = (status: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResultV2 => ({ statusCode: status, headers: { "content-type": "application/json", ...noStore, ...headers }, body: JSON.stringify(body) });
const fail = (error: string, description: string, status = 400) => json(status, { error, error_description: description });
const redirect = (location: string): APIGatewayProxyResultV2 => ({ statusCode: 302, headers: { location, ...noStore }, body: "" });
const page = (status: number, title: string, text: string): APIGatewayProxyResultV2 => ({ statusCode: status, headers: { "content-type": "text/html; charset=utf-8", ...noStore, "x-frame-options": "DENY" },
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.3rem">${title}</h1><p>${text}</p></body>` });

const OAUTH_DDL = `
CREATE TABLE IF NOT EXISTS data_room_oauth_clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS data_room_oauth_logins (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, client_state TEXT,
  auth0_verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS data_room_oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
  subject TEXT NOT NULL, email TEXT NOT NULL, name TEXT, expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS data_room_oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), client_id TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL, name TEXT,
  access_hash TEXT NOT NULL UNIQUE, refresh_hash TEXT UNIQUE, access_expires_at TIMESTAMPTZ NOT NULL, refresh_expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;
let ready: Promise<void> | undefined;
function ensureOAuthSchema() {
  ready ??= getPool().query(OAUTH_DDL).then(() => undefined).catch((e) => { ready = undefined; throw e; });
  return ready;
}

// Base of the public API ("…/mcp" without "/mcp"); works behind investors.deeptrack.io/api too.
export function oauthBase(resource: string) { return resource.replace(/\/mcp$/, ""); }

export function authorizationServerMetadata(base: string): APIGatewayProxyResultV2 {
  return json(200, {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  });
}

// Only Claude's own callbacks (and localhost for Claude Code / desktop) may receive codes,
// so nobody can register a client that sends a signed-in founder's code elsewhere.
const CLAUDE_HOSTS = ["claude.ai", "claude.com"];
function redirectAllowed(uri: string) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return CLAUDE_HOSTS.includes(u.hostname);
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch { return false; }
}
function pkceOk(verifier: string, challenge: string) {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(sha256(verifier)); const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
function withParams(uri: string, params: Record<string, string | undefined | null>) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}
function bodyParams(event: APIGatewayProxyEventV2) {
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";
  const type = String(event.headers["content-type"] ?? event.headers["Content-Type"] ?? "");
  if (type.includes("application/json")) { try { return new URLSearchParams(Object.entries(JSON.parse(raw || "{}") as Record<string, string>).map(([k, v]) => [k, String(v)])); } catch { return new URLSearchParams(); } }
  return new URLSearchParams(raw);
}

export async function register(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  await ensureOAuthSchema();
  let body: { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown };
  try { body = JSON.parse(event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "{}"); }
  catch { return fail("invalid_client_metadata", "Send client metadata as JSON."); }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length || uris.length > 10 || !uris.every(redirectAllowed)) return fail("invalid_redirect_uri", "redirect_uris must be Claude callbacks (https://claude.ai or https://claude.com) or http on localhost.");
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") return fail("invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) are supported.");
  const id = `drm_${random(18)}`;
  const name = (typeof body.client_name === "string" ? body.client_name : "Claude").slice(0, 120);
  await query("INSERT INTO data_room_oauth_clients (id, name, redirect_uris) VALUES ($1,$2,$3)", [id, name, uris]);
  return json(201, { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
}

// Step 1: Claude sends the person here. Check the request, then hand off to Auth0 (Google).
export async function authorize(event: APIGatewayProxyEventV2, base: string): Promise<APIGatewayProxyResultV2> {
  await ensureOAuthSchema();
  const q = event.queryStringParameters ?? {};
  const clientId = q.client_id ?? ""; const redirectUri = q.redirect_uri ?? "";
  const client = (await query<{ redirect_uris: string[] }>("SELECT redirect_uris FROM data_room_oauth_clients WHERE id=$1", [clientId])).rows[0];
  if (!client || !client.redirect_uris.includes(redirectUri)) return page(400, "Can't connect", "This connection request isn't valid. Remove the connector in Claude and add it again.");
  if (q.response_type !== "code") return redirect(withParams(redirectUri, { error: "unsupported_response_type", state: q.state, iss: base }));
  if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? "")) return redirect(withParams(redirectUri, { error: "invalid_request", error_description: "PKCE (S256) is required", state: q.state, iss: base }));
  const id = random(24); const verifier = random(48); const nonce = random(16);
  await query("INSERT INTO data_room_oauth_logins (id, client_id, redirect_uri, code_challenge, client_state, auth0_verifier, nonce, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8))",
    [id, clientId, redirectUri, q.code_challenge, q.state ?? null, verifier, nonce, LOGIN_TTL]);
  if (Math.random() < 0.05) await query("DELETE FROM data_room_oauth_logins WHERE expires_at < now() - interval '1 day'");
  return redirect(withParams(`${authIssuer()}authorize`, {
    response_type: "code", client_id: loginClientId(), redirect_uri: `${base}/oauth/callback`, scope: "openid email profile",
    state: id, nonce, code_challenge: sha256(verifier), code_challenge_method: "S256", prompt: "select_account",
  }));
}

// Step 2: Auth0 sends the person back. Confirm who they are, check the allow-list, give Claude a code.
export async function callback(event: APIGatewayProxyEventV2, base: string): Promise<APIGatewayProxyResultV2> {
  await ensureOAuthSchema();
  const q = event.queryStringParameters ?? {};
  const login = (await query<{ client_id: string; redirect_uri: string; code_challenge: string; client_state: string | null; auth0_verifier: string; nonce: string; expires_at: Date }>(
    "DELETE FROM data_room_oauth_logins WHERE id=$1 RETURNING *", [q.state ?? ""])).rows[0];
  if (!login || new Date(login.expires_at) < new Date()) return page(400, "Sign-in expired", "That sign-in link has expired. Go back to Claude and click Connect again.");
  const back = (params: Record<string, string | undefined>) => redirect(withParams(login.redirect_uri, { ...params, state: login.client_state ?? undefined, iss: base }));
  if (q.error || !q.code) return back({ error: "access_denied", error_description: q.error_description ?? "Sign-in was cancelled" });

  let email = ""; let subject = ""; let name: string | undefined;
  try {
    const res = await fetch(`${authIssuer()}oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ grant_type: "authorization_code", client_id: loginClientId(), code: q.code, code_verifier: login.auth0_verifier, redirect_uri: `${base}/oauth/callback` }) });
    const tokens = await res.json() as { id_token?: string; error_description?: string };
    if (!res.ok || !tokens.id_token) throw new Error(tokens.error_description || `Auth0 token exchange failed (${res.status})`);
    const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(`${authIssuer()}.well-known/jwks.json`)), { issuer: authIssuer(), audience: loginClientId() });
    if (payload.nonce !== login.nonce) throw new Error("nonce mismatch");
    if (payload.email_verified !== true || typeof payload.email !== "string" || !payload.sub) throw new Error("no verified email");
    email = payload.email.trim().toLowerCase(); subject = payload.sub; name = typeof payload.name === "string" ? payload.name : undefined;
  } catch (error) {
    console.error("connector-signin-failed", error instanceof Error ? error.message : "unknown");
    return back({ error: "server_error", error_description: "Sign-in with Auth0 failed. Try again." });
  }
  const meta = { ip: event.requestContext.http.sourceIp, userAgent: event.headers["user-agent"], createdAt: new Date().toISOString() };
  if (!mcpAllowedEmails().includes(email)) {
    await insertAudit({ event: "connector_access_denied", actorSubject: subject, actorEmail: email, detail: JSON.stringify({ client: login.client_id }), ...meta });
    return page(403, "Not allowed", "This Google account can't connect Claude to the Deeptrack data room. Sign in with an approved account, or ask Bryan to add yours.");
  }
  const code = random();
  await query("INSERT INTO data_room_oauth_codes (code_hash, client_id, redirect_uri, code_challenge, subject, email, name, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8))",
    [sha256(code), login.client_id, login.redirect_uri, login.code_challenge, subject, email, name ?? null, CODE_TTL]);
  await insertAudit({ event: "connector_authorized", actorSubject: subject, actorEmail: email, detail: JSON.stringify({ client: login.client_id }), ...meta });
  return back({ code });
}

async function issueTokens(v: { clientId: string; subject: string; email: string; name: string | null }) {
  const access = `drm_at_${random()}`; const refresh = `drm_rt_${random()}`;
  await query("INSERT INTO data_room_oauth_tokens (client_id, subject, email, name, access_hash, refresh_hash, access_expires_at, refresh_expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), now() + make_interval(secs => $8))",
    [v.clientId, v.subject, v.email, v.name, sha256(access), sha256(refresh), ACCESS_TTL, REFRESH_TTL]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE };
}

// Step 3: Claude swaps the code for tokens (and later refreshes them).
export async function token(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  await ensureOAuthSchema();
  const p = bodyParams(event);
  const clientId = p.get("client_id") ?? "";
  if (p.get("grant_type") === "authorization_code") {
    const row = (await query<{ client_id: string; redirect_uri: string; code_challenge: string; subject: string; email: string; name: string | null; expires_at: Date }>(
      "DELETE FROM data_room_oauth_codes WHERE code_hash=$1 RETURNING *", [sha256(p.get("code") ?? "")])).rows[0];
    if (!row || new Date(row.expires_at) < new Date()) return fail("invalid_grant", "The code is invalid, expired or already used.");
    if (row.client_id !== clientId) return fail("invalid_grant", "The code was issued to a different client.");
    if (row.redirect_uri !== (p.get("redirect_uri") ?? "")) return fail("invalid_grant", "redirect_uri doesn't match the authorization request.");
    if (!pkceOk(p.get("code_verifier") ?? "", row.code_challenge)) return fail("invalid_grant", "PKCE verification failed.");
    return json(200, await issueTokens({ clientId, subject: row.subject, email: row.email, name: row.name }));
  }
  if (p.get("grant_type") === "refresh_token") {
    // Refresh tokens rotate: the old pair is revoked and a new one issued.
    const tokens = await withTransaction(async (client) => {
      const row = (await client.query("UPDATE data_room_oauth_tokens SET revoked_at = now() WHERE refresh_hash=$1 AND revoked_at IS NULL AND refresh_expires_at > now() AND client_id=$2 RETURNING client_id, subject, email, name", [sha256(p.get("refresh_token") ?? ""), clientId])).rows[0];
      return row ? row : null;
    });
    if (!tokens) return fail("invalid_grant", "The refresh token is invalid, expired or revoked.");
    if (!mcpAllowedEmails().includes(tokens.email)) return fail("invalid_grant", "This account is no longer allowed to use the connector.");
    return json(200, await issueTokens({ clientId, subject: tokens.subject, email: tokens.email, name: tokens.name }));
  }
  return fail("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

export async function revoke(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  await ensureOAuthSchema();
  const t = bodyParams(event).get("token") ?? "";
  if (t) await query("UPDATE data_room_oauth_tokens SET revoked_at = now() WHERE (access_hash=$1 OR refresh_hash=$1) AND revoked_at IS NULL", [sha256(t)]);
  return { statusCode: 200, headers: noStore, body: "" };
}

// Access tokens the data room issued ("drm_at_…"). Returns undefined when not one of ours or no longer valid.
export function isConnectorToken(token: string) { return token.startsWith("drm_at_"); }
export async function verifyConnectorToken(token: string): Promise<AuthContext | undefined> {
  await ensureOAuthSchema();
  const row = (await query<{ id: string; subject: string; email: string; name: string | null; last_used_at: Date | null }>(
    "SELECT id, subject, email, name, last_used_at FROM data_room_oauth_tokens WHERE access_hash=$1 AND revoked_at IS NULL AND access_expires_at > now()", [sha256(token)])).rows[0];
  if (!row) return undefined;
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) await query("UPDATE data_room_oauth_tokens SET last_used_at = now() WHERE id=$1", [row.id]);
  return { subject: row.subject, email: row.email, verifiedEmail: row.email, name: row.name ?? undefined, role: "founder", clearanceTier: 3 };
}
