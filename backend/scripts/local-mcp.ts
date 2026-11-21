// Local MCP server for trying the connector with the MCP Inspector, without AWS.
// Starts an embedded Postgres, a stand-in Auth0 (signs one test token) and an HTTP
// server that feeds requests to the Lambda handler. Test data only.
//
//   cd backend && npx tsx scripts/local-mcp.ts
//   npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp --transport http \
//     --header "Authorization: Bearer <token printed below>" --method tools/list
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const PORT = Number(process.env.PORT || 8787);
const PG_PORT = 55990;
const EMAIL = process.env.LOCAL_MCP_EMAIL || "local.admin@example.test";

const pg = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), "dr-local-")), user: "postgres", password: "local", port: PG_PORT, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {} });
await pg.initialise(); await pg.start();

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "local", alg: "RS256", use: "sig" };
const issuerServer = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/.well-known/jwks.json") return res.end(JSON.stringify({ keys: [jwk] }));
  if (req.url === "/userinfo") return res.end(JSON.stringify({ email: EMAIL, email_verified: true }));
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => issuerServer.listen(0, "127.0.0.1", r));
const issuer = `http://127.0.0.1:${(issuerServer.address() as { port: number }).port}`;
const resource = `http://127.0.0.1:${PORT}/mcp`;

Object.assign(process.env, {
  AUTH0_ISSUER: issuer, AUTH0_AUDIENCE: "https://local.test/data-room", MCP_RESOURCE_URL: resource,
  DATABASE_URL: `postgresql://postgres:local@127.0.0.1:${PG_PORT}/postgres`, DATABASE_SSL: "false", MCP_ALLOWED_EMAILS: EMAIL,
});
const { handler } = await import("../src/handler.js");

const token = await new SignJWT({ email: EMAIL, email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "local" })
  .setSubject(`local|${EMAIL}`).setIssuer(`${issuer}/`).setAudience(resource).setIssuedAt().setExpirationTime("8h").sign(privateKey);

createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const event = {
    version: "2.0", routeKey: "$default", rawPath: url.pathname, rawQueryString: url.search.slice(1),
    queryStringParameters: url.search ? Object.fromEntries(url.searchParams) : undefined,
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")])),
    body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined, isBase64Encoded: false,
    requestContext: { domainName: `127.0.0.1:${PORT}`, http: { method: req.method ?? "GET", path: url.pathname, sourceIp: "127.0.0.1", userAgent: String(req.headers["user-agent"] ?? ""), protocol: "HTTP/1.1" } },
  } as unknown as APIGatewayProxyEventV2;
  const out = await handler(event);
  const r = typeof out === "string" ? { statusCode: 200, body: out, headers: {} } : out;
  res.writeHead(r.statusCode ?? 200, (r.headers ?? {}) as Record<string, string>); res.end(r.body ?? "");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Local data room MCP: ${resource}`);
  console.log(`Signed in as ${EMAIL}. Bearer token (8h):\n${token}`);
});

const stop = async () => { await pg.stop(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
