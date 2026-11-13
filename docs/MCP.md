# Data room connector for Claude (MCP)

The data room API exposes a remote MCP server so Claude (claude.ai, the Claude
desktop app and Claude Code) can work with the data room on your behalf.

- URL: `https://9a8681dr9d.execute-api.eu-west-1.amazonaws.com/mcp`
- Who can use it: Founder and Investor Relations only. Any other account gets 403.
- Sign-in: Auth0, the same tenant as the web app. Claude never sees a password.
- Every tool runs through the same API route the web app uses, so checks and the
  audit log are identical. Audit entries show the Claude client as user agent.

## Tools

| Area | Tools |
| --- | --- |
| Account | `whoami` |
| Documents | `list_documents`, `get_document_link`, `add_linked_document`, `set_document_status`, `add_document_version` |
| Access | `list_access_grants`, `grant_access`, `revoke_access`, `audit_log` |
| Investor pipeline | `list_investors` (filter by stage, priority, text, follow-ups due), `get_investor`, `create_investor`, `update_investor`, `log_investor_activity` |

Investors can be named by UUID, Investor ID (`INV-007`) or name. File uploads
stay in the web app; Claude can add documents that live at an HTTPS link.

## One-time Auth0 setup (tenant admin)

Tenant: `dev-08kwsss3wr77v0k0.us.auth0.com`.

1. **API for the connector.** Applications → APIs → Create API.
   Identifier: `https://9a8681dr9d.execute-api.eu-west-1.amazonaws.com/mcp`
   (exactly the MCP URL). Signing algorithm RS256.
2. **Resource parameter.** Settings → Advanced → turn on
   **Resource Parameter Compatibility Profile**. Claude sends the MCP URL as
   `resource`; this makes Auth0 use it as the token audience.
3. **Client for Claude.** Applications → Create Application → "Claude data room
   connector", type Regular Web Application.
   - Allowed Callback URLs:
     `https://claude.ai/api/mcp/auth_callback, https://claude.com/api/mcp/auth_callback, http://localhost:8765/callback`
   - Connections: enable the same Google connection the web app uses.
   - Note the Client ID and Client Secret (keep the secret out of chat and git).

A pre-registered client is used instead of Dynamic Client Registration so that
nobody can register their own client against the tenant.

## Connect Claude

**claude.ai / desktop app:** Settings → Connectors → Add custom connector.
Name "Deeptrack data room", URL as above. Under Advanced settings, paste the
Client ID and Client Secret from step 3. Then Connect and sign in with Google.

**Claude Code:**

```bash
claude mcp add --transport http --client-id <CLIENT_ID> --client-secret --callback-port 8765 deeptrack-data-room https://9a8681dr9d.execute-api.eu-west-1.amazonaws.com/mcp
```

It prompts for the secret, then run `/mcp` in Claude Code to sign in.

## Discovery endpoints

- `GET /.well-known/oauth-protected-resource` (RFC 9728) names Auth0 as the
  authorization server.
- Unauthenticated `POST /mcp` returns 401 with a `WWW-Authenticate` header that
  points at that metadata.
- `MCP_RESOURCE_URL` (optional env var) overrides the resource URL, e.g. if the
  API moves to a custom domain. Update the Auth0 API identifier to match.
