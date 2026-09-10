import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { AuthContext, ClearanceTier, Role } from "./types.js";

const issuer = () => required("AUTH0_ISSUER").replace(/\/$/, "");
const audience = () => required("AUTH0_AUDIENCE");
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

export async function requireAuth(event: APIGatewayProxyEventV2, minimum: "any" | "admin" = "any"): Promise<AuthContext> {
  const raw = event.headers.authorization || event.headers.Authorization;
  if (!raw?.startsWith("Bearer ")) throw new Error("Authentication required");
  const token = raw.slice(7).trim();
  const { payload } = await jwtVerify(token, jwks(), { issuer: `${issuer()}/`, audience: audience() });
  if (!payload.sub) throw new Error("Authenticated identity has no subject");
  const role = resolveRole(payload);
  if (minimum === "admin" && role === "investor") throw new Error("Administrator role required");
  const clearanceTier: ClearanceTier = role === "investor" ? 1 : 3;
  return {
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
    role,
    clearanceTier,
    companyId: typeof payload[companyClaim()] === "string" ? payload[companyClaim()] as string : undefined,
  };
}
