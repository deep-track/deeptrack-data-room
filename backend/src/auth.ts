import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { AuthContext, ClearanceTier, Role } from "./types.js";

const issuer = () => required("AUTH0_ISSUER").replace(/\/$/, "");
const audience = () => required("AUTH0_AUDIENCE");
export const authIssuer = () => `${issuer()}/`;
const roleClaim = () => process.env.AUTH0_ROLE_CLAIM?.trim() || "https://deeptrack.io/roles";
const companyClaim = () => process.env.AUTH0_COMPANY_ID_CLAIM?.trim() || "https://deeptrack.io/company_id";
const jwks = () => createRemoteJWKSet(new URL(`${issuer()}/.well-known/jwks.json`));

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server configuration: ${name}`);
  return value;
}

function values(payload: JWTPayload, claim: string) {
  const value = payload[claim];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

export function resolveRole(payload: JWTPayload): Role {
  const claims = [...values(payload, roleClaim()), ...values(payload, "https://deeptrack.io/role")]
    .map((value) => value.trim().toLowerCase());
  const verifiedEmail = payload.email_verified === true && typeof payload.email === "string"
    ? payload.email.trim().toLowerCase()
    : typeof payload["https://deeptrack.io/verified_email"] === "string"
      ? payload["https://deeptrack.io/verified_email"].trim().toLowerCase()
      : "";

  // Keep this fallback aligned with the deployed Auth0 Post-Login Action. The
  // email is read from the verified JWT claim, never from browser input, so a
  // stale/misconfigured role claim cannot lock an approved administrator out.
  if (verifiedEmail === "bryan@deeptrack.io" || claims.some((value) => ["founder", "owner", "head"].includes(value))) return "founder";
  if (verifiedEmail === "ygachara@deeptrack.io" || claims.some((value) => ["investorrelations", "investor_relations", "investor-relations", "admin"].includes(value))) return "investorRelations";
  if (claims.some((value) => ["investor", "user"].includes(value))) return "investor";
  // A valid authenticated identity without an elevated claim is an investor.
  // This preserves open Google sign-in while keeping all document access and
  // clearance decisions behind server-side grants and tier checks.
  return "investor";
}

// When the Auth0 Post-Login Action has not added role or verified-email claims
// to the access token, ask Auth0 who the token belongs to. /userinfo only
// answers for a valid token and its email_verified flag comes from Auth0, so
// this cannot be spoofed by the browser. Results are cached per token.
const userinfoCache = new Map<string, { expires: number; payload: JWTPayload }>();
async function verifiedEmailFromAuth0(token: string, tokenExpiry?: number): Promise<JWTPayload> {
  const key = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  const cached = userinfoCache.get(key);
  if (cached && cached.expires > now) return cached.payload;
  try {
    const response = await fetch(`${issuer()}/userinfo`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return {};
    const info = await response.json() as { email?: unknown; email_verified?: unknown };
    const payload: JWTPayload = info.email_verified === true && typeof info.email === "string" ? { email: info.email, email_verified: true } : {};
    if (userinfoCache.size > 500) userinfoCache.clear();
    userinfoCache.set(key, { payload, expires: Math.min(now + 10 * 60 * 1000, (tokenExpiry ?? 0) * 1000 || now + 60 * 1000) });
    return payload;
  } catch {
    return {};
  }
}

// Tokens may be issued for the web app's API audience or, for Claude's MCP
// connector, for the MCP endpoint URL itself (OAuth "resource" parameter).
export async function requireAuth(event: APIGatewayProxyEventV2, minimum: "any" | "admin" = "any", extraAudiences: string[] = []): Promise<AuthContext> {
  const raw = event.headers.authorization || event.headers.Authorization;
  if (!raw?.startsWith("Bearer ")) throw new Error("Authentication required");
  const token = raw.slice(7).trim();
  const { payload } = await jwtVerify(token, jwks(), { issuer: `${issuer()}/`, audience: [audience(), ...extraAudiences] });
  if (!payload.sub) throw new Error("Authenticated identity has no subject");
  let role = resolveRole(payload);
  let verified: JWTPayload = {};
  // The token alone says "investor": confirm with Auth0 before settling on that.
  if (role === "investor") { verified = await verifiedEmailFromAuth0(token, payload.exp); role = resolveRole({ ...payload, ...verified }); }
  if (minimum === "admin" && role === "investor") throw new Error("Administrator role required");
  const clearanceTier: ClearanceTier = role === "investor" ? 1 : 3;
  const verifiedEmail = typeof verified.email === "string" ? verified.email
    : payload.email_verified === true && typeof payload.email === "string" ? payload.email
    : typeof payload["https://deeptrack.io/verified_email"] === "string" ? payload["https://deeptrack.io/verified_email"] as string : undefined;
  return {
    subject: payload.sub,
    verifiedEmail: verifiedEmail?.trim().toLowerCase(),
    email: typeof payload.email === "string" ? payload.email : typeof verified.email === "string" ? verified.email : typeof payload["https://deeptrack.io/verified_email"] === "string" ? payload["https://deeptrack.io/verified_email"] as string : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
    role,
    clearanceTier,
    companyId: typeof payload[companyClaim()] === "string" ? payload[companyClaim()] as string : undefined,
  };
}
