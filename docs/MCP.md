# Data room connector for Claude (MCP)

The data room API exposes a remote MCP server so Claude (claude.ai, Cowork, the
Claude desktop app and Claude Code) can read and, with your approval, update the
data room and the private investor pipeline. The pipeline in the data room is the
single source of truth for fundraising: the daily and Saturday Investor Relations
briefs read it instead of rebuilding a table from email.

- **URL today:** `https://9a8681dr9d.execute-api.eu-west-1.amazonaws.com/mcp`
- **URL after the CloudFront step below:** `https://investors.deeptrack.io/api/mcp`
- **Who can use it:** only the allow-list (see "Who can sign in"). Everyone else gets 403,
  including other data room admins.
- **Sign-in:** add the URL in Claude and click Connect, like the Deeptrack CRM. The data room
  runs its own small sign-in service for Claude (`backend/src/oauth.ts`). It hands off to Auth0
  (the web app's Google sign-in) and then issues its own tokens. Claude never sees a password,
  and no Client ID or secret is needed.
- **Same rules as the web app:** every tool runs through the API route the web app
  uses, so validation, the Banned / do-not-contact rule and the audit log are identical.

## Tools

| Area | Tools |
| --- | --- |
| Account | `whoami` |
| Documents | `list_documents`, `get_document_link`, `add_linked_document`, `set_document_status`, `add_document_version` |
| Access | `list_access_grants`, `invite_investor`, `set_investor_tier`, `revoke_access`, `audit_log` |
| Pipeline, read | `list_investors`, `get_investor`, `pipeline_summary`, `data_room_activity` |
| Pipeline, write | `upsert_investor`, `log_activity`, `move_stage`, `set_next_step`, `bulk_import` |

- `list_investors` filters by stage, type, round, tag, overdue, next step due within N days and
  text, and pages with `limit` / `offset`.
- `pipeline_summary` gives counts by stage, overdue next steps, meetings in the next 7 days,
  the committed amount (where recorded), stale investors (no touch in 10+ working days) and
  investors awaiting our reply. "Today" is Nairobi time.
- `data_room_activity` lists who viewed or downloaded which documents since a date, and NDA
  acceptances, matched to pipeline investors by email.
- `upsert_investor` creates, or updates by Investor ID / email / name + organisation. Only the
  fields sent change. The stage is set only when creating; after that use `move_stage`.
- `log_activity` records an email, call, meeting, note, form or intro, with a direction (in or out)
  and an optional link. It updates `last_touch_date` / `last_touch_by` (a note doesn't) and can
  set the next step.
- `move_stage` needs a reason for Passed and Banned.
- `bulk_import` is a dry run unless `commit: true`. It matches on email first, then on
  name + organisation. Empty cells never clear data, and conflicting rows are listed and skipped.

The server's instructions tell Claude to show you each write and get approval first.
Investors can be named by Investor ID (`INV-007`), UUID, email or name.

### Investor model (Nov 2026)

| Field | Values |
| --- | --- |
| stage | Intro pending, Contacted, Replied, Deck sent, Meeting booked, Diligence, Committed, Closed, Passed, Reconnect later, Banned |
| type | VC, Angel, Angel network, Accelerator, Grant, Warm introducer, Capital advisor, Connector, Reference |
| round | `pre-seed-750k` (default), `bridge-100k` (Isaak Hayes only) |
| last_touch_by | `bryan`, `investor` |
| tags | lowercase-with-dashes, e.g. `last-nudge-sent`, `do-not-contact` |

**Banned** investors, and any tagged **do-not-contact**, refuse every write except a stage
change by an admin (`move_stage`, which needs a reason to lift do-not-contact). This holds in
the web app too.

On first use after deploy, the API migrates old stage names and records each move in the
investor's history (`backend/sql/003_investor_pipeline_v2.sql`):

| Old | New |
| --- | --- |
| Not started, Drafted, Check, Intro requested | Intro pending |
| Waiting reply | Contacted, or Deck sent if the deck was sent |
| Due diligence / Term sheet / Closed won | Diligence / Committed / Closed |
| Watch, On hold | Reconnect later |
| Do not contact | Banned, plus a do-not-contact tag |

Free-text rounds become `pre-seed-750k`, and the old value is kept in notes.

## Audit and limits

- Every pipeline write adds an audit event (`investor_created`, `investor_updated`,
  `investor_stage_changed`, `investor_activity_logged`, `investors_bulk_imported`). Each event
  records who (actor), when, how (`via: mcp` plus the tool name, or `via: web`) and every field
  changed, before → after.
- The audit table is append-only: a database trigger refuses UPDATE and DELETE.
- Rate limits are per signed-in user: 120 MCP requests and 30 write calls a minute, shared
  across Lambda instances. Override them with `MCP_RATE_LIMIT_PER_MINUTE` and
  `MCP_WRITE_LIMIT_PER_MINUTE`. API Gateway also throttles overall.
- Secrets (database URL, Auth0 client secret) live only in AWS (Secrets Manager / Lambda
  environment). Nothing secret is logged, and errors from bad input are not logged at all.

## Who can sign in

Only the two founder Google accounts built into `backend/src/auth.ts`
(`DEFAULT_MCP_EMAILS`: Bryan's work and personal addresses), plus any emails in the
`McpAllowedEmails` stack parameter (Lambda env `MCP_ALLOWED_EMAILS`, comma-separated). The
check uses the email Auth0 has verified, never one the client sends. An allow-listed account
acts as an administrator inside the connector only.

## Connect Claude

Use **Settings → Connectors → Add custom connector**. This works in claude.ai, Cowork and the
desktop app.

1. Name it "Deeptrack data room" and paste the URL above. Leave Advanced settings empty.
2. Click **Connect** and sign in with Google using an allow-listed account.

Behind the scenes:
- Claude registers itself (only Claude's own callback addresses are accepted).
- Google sign-in goes through Auth0 with PKCE.
- The data room checks the allow-list and issues an access token (1 hour) and a refresh token
  (30 days, rotated on each use).
- Tokens are stored only as hashes.
- Removing an email from the allow-list stops its refreshes and new sign-ins.

**One-time Auth0 step:** the web app's Auth0 application ("Deeptrack Data Room",
client `2nsfWPfcCPkxA3N7Me4aUwjlSsDeoFbM`) must list
`https://9a8681dr9d.execute-api.eu-west-1.amazonaws.com/oauth/callback` under Allowed Callback URLs.

The older route, an Auth0 Client ID and secret under Advanced settings, still works.

**Claude Code:**

```bash
claude mcp add --transport http --client-id <CLIENT_ID> --client-secret --callback-port 8765 deeptrack-data-room <MCP URL>
```

It prompts for the secret. Then run `/mcp` in Claude Code to sign in.

## Revoke access

- **One person, from the server side:** remove their email from `McpAllowedEmails` and deploy
  (for a built-in account, edit `DEFAULT_MCP_EMAILS`). Their next request gets 403.
- **One connection:** in Claude, Settings → Connectors → the data room → Disconnect. In Auth0,
  User Management → Users → the user → Authorized Applications → revoke "Claude data room
  connector".
- **All connectors at once:** in Auth0, rotate the client secret of "Claude data room
  connector", or disable that application. The web app is unaffected.

## One-time Auth0 setup (tenant admin)

Tenant: `dev-08kwsss3wr77v0k0.us.auth0.com`.

1. **API for the connector.** Applications → APIs → Create API. Set Identifier to exactly the
   MCP URL. Signing algorithm RS256.
2. **Resource parameter.** Settings → Advanced → turn on **Resource Parameter Compatibility
   Profile**. Claude sends the MCP URL as `resource`, and this makes Auth0 use it as the token
   audience.
3. **Client for Claude.** Applications → Create Application → "Claude data room connector",
   type Regular Web Application.
   - Allowed Callback URLs:
     `https://claude.ai/api/mcp/auth_callback, https://claude.com/api/mcp/auth_callback, http://localhost:8765/callback`
   - Connections: enable the same Google connection the web app uses.

The client is pre-registered instead of using Dynamic Client Registration, so nobody can
register their own client against the tenant. That's why the Client ID and secret go in
Advanced settings.

## Moving the URL to investors.deeptrack.io/api/mcp

The API already accepts an `/api` prefix. To serve the connector from the data room's own domain:

1. **CloudFront** (distribution `E3JP1T0XSJ1O0M`, investors.deeptrack.io):
   - Add an origin for `9a8681dr9d.execute-api.eu-west-1.amazonaws.com` (HTTPS only).
   - Add behaviors for `/api/*` and `/.well-known/oauth-protected-resource*` pointing at that
     origin.
   - On those behaviors: all HTTP methods, caching disabled (CachingDisabled), origin request
     policy AllViewerExceptHostHeader.
   - The API strips `/api` itself.
2. **Auth0:** create a second API whose identifier is `https://investors.deeptrack.io/api/mcp`
   (keep the old one until every client has reconnected).
3. **Stack:** set `McpResourceUrl=https://investors.deeptrack.io/api/mcp` in the buildspec
   parameter overrides and deploy.
4. **Claude:** remove the old connector and add the new URL.

## Test locally (MCP Inspector)

```bash
cd backend
npm test                      # 24 tests: real Postgres (embedded) + local stand-in for Auth0
npx tsx scripts/local-mcp.ts  # local MCP server with test data only; prints a bearer token
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp --transport http \
  --header "Authorization: Bearer <token>" --method tools/list
```

## Discovery endpoints

- `GET /.well-known/oauth-protected-resource` (RFC 9728) names Auth0 as the authorization server.
- An unauthenticated `POST /mcp` returns 401 with a `WWW-Authenticate` header that points at
  that metadata.
- `MCP_RESOURCE_URL` (the `McpResourceUrl` stack parameter) overrides the resource URL.
