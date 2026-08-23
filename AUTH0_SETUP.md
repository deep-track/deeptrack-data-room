# Auth0 setup — Deeptrack Data Room

## Frontend values

Configure these as build-time frontend variables:

```text
VITE_AUTH0_DOMAIN=dev-08kwsss3wr77v0k0.us.auth0.com
VITE_AUTH0_CLIENT_ID=2nsfWPfcCPkxA3N7Me4aUwjlSsDeoFbM
VITE_AUTH0_AUDIENCE=https://api.deeptrack.io/data-room
VITE_AUTH0_ORGANIZATION_ID=<approved Auth0 organization ID, if Business Users is enabled>
VITE_AUTH0_ROLE_CLAIM=https://deeptrack.io/roles
VITE_DATA_ROOM_API_BASE_URL=<AWS API Gateway base URL>
```

The frontend uses the Auth0 React SDK with Authorization Code Flow + PKCE, refresh-token support, and in-memory token caching. It requests an access token for the configured API audience and attaches it as a Bearer token to production data-room API requests.

## Auth0 dashboard configuration

Create a **Single Page Application** named `Deeptrack Data Room`. Its verified client ID is `2nsfWPfcCPkxA3N7Me4aUwjlSsDeoFbM`. Configure the exact local and production callback URLs, logout URLs, allowed web origins, and CORS origins. The production values configured in Auth0 are:

```text
Allowed Callback URL: https://investors.deeptrack.io/
Allowed Logout URL: https://investors.deeptrack.io/
Allowed Web Origin: https://investors.deeptrack.io
Allowed CORS Origin: https://investors.deeptrack.io
```

If the existing Auth0 Business Users experience is used, configure the organisation on the authorization request and ensure the approved users are members of that organisation. The organisation identifier must be supplied as a protected frontend build variable or server-side configuration as appropriate for the final flow.

The Auth0 API `Deeptrack Data Room API` is configured with audience `https://api.deeptrack.io/data-room`. The Lambda verifies the JWT issuer, audience, signature, and expiry using the Auth0 JWKS endpoint. Role claims should be emitted by a deployed Post-Login Action under the namespaced claim `https://deeptrack.io/roles`.

## Role expectations

The production API must resolve roles from verified Auth0 claims. Browser-entered email addresses must never grant Founder or Investor Relations privileges. The intended roles are:

| Role | Access |
|---|---|
| Founder | Full room governance, document publication, access policy, administrator assignment, and audit oversight. |
| Investor Relations Officer | Document filing, controlled publication within policy, invitations, Q&A, and reporting. |
| Investor | Approved documents within assigned clearance, permitted downloads, NDA acknowledgement, and questions. |

## Security notes

Do not put Auth0 client secrets, management API secrets, database credentials, AWS credentials, or long-lived tokens in the Vite bundle. The browser may contain the public Auth0 domain, public client ID, and API audience; all authorization decisions remain server-side. The current local review login is available only when Auth0 variables are not configured and must not be used for production.
