# Deeptrack Investor Data Room — DevOps Handoff

## Current status

The investor data room is prepared for AWS-native deployment. The frontend is a Vite React single-page application, while the backend is an AWS Lambda function behind an API Gateway HTTP API. Document metadata is persisted in PostgreSQL, and document files are stored privately in S3 using presigned URLs. The application has been compiled successfully with the current source tree.

Auth0 is configured in the development tenant `dev-08kwsss3wr77v0k0.us.auth0.com`. The API and SPA are separate Auth0 resources and must not be replaced with the existing Sentinel application.

## Verified Auth0 configuration

| Item | Verified value |
|---|---|
| Auth0 tenant domain | `dev-08kwsss3wr77v0k0.us.auth0.com` |
| Issuer URL | `https://dev-08kwsss3wr77v0k0.us.auth0.com/` |
| API name | `Deeptrack Data Room API` |
| API audience | `https://api.deeptrack.io/data-room` |
| JWT signing algorithm | RS256 |
| SPA name | `Deeptrack Data Room` |
| SPA client ID | `2nsfWPfcCPkxA3N7Me4aUwjlSsDeoFbM` |
| Allowed callback URL | `https://investors.deeptrack.io/` |
| Allowed logout URL | `https://investors.deeptrack.io/` |
| Allowed web origin | `https://investors.deeptrack.io` |
| Allowed CORS origin | `https://investors.deeptrack.io` |
| Namespaced role claim | `https://deeptrack.io/roles` |

No Auth0 client secret is required by the SPA. Do not create or inject a client secret into the browser build.

## Frontend build configuration

The verified public Auth0 values are recorded in `.env.example` and `AUTH0_SETUP.md`. Before the production build, DevOps must provide the deployed API Gateway URL as `VITE_DATA_ROOM_API_BASE_URL`. The production build should contain values equivalent to the following:

```text
VITE_AUTH0_DOMAIN=dev-08kwsss3wr77v0k0.us.auth0.com
VITE_AUTH0_CLIENT_ID=2nsfWPfcCPkxA3N7Me4aUwjlSsDeoFbM
VITE_AUTH0_AUDIENCE=https://api.deeptrack.io/data-room
VITE_AUTH0_ROLE_CLAIM=https://deeptrack.io/roles
VITE_DATA_ROOM_API_BASE_URL=https://<api-id>.execute-api.<aws-region>.amazonaws.com
```

`VITE_AUTH0_ORGANIZATION_ID` should remain unset until an approved Auth0 Organization is selected and its membership policy is finalized. The frontend retains local review mode as a fallback when the API base URL is empty, but this mode must not be used for the production investor site.

## Lambda environment variables

Configure the Lambda environment through protected deployment configuration. Keep database credentials and infrastructure secrets out of the Vite bundle and Git repository.

| Variable | Value or source |
|---|---|
| `AUTH0_ISSUER` | `https://dev-08kwsss3wr77v0k0.us.auth0.com/` |
| `AUTH0_AUDIENCE` | `https://api.deeptrack.io/data-room` |
| `AUTH0_ROLE_CLAIM` | `https://deeptrack.io/roles` |
| `AUTH0_COMPANY_ID_CLAIM` | `https://deeptrack.io/company_id` unless the claim model changes |
| `DATA_ROOM_ORIGIN` | `https://investors.deeptrack.io` |
| `DATA_ROOM_S3_BUCKET` | The private S3 bucket created by the SAM stack |
| `DATABASE_URL` | PostgreSQL connection string from protected configuration |
| `DATABASE_SSL` | `true` |
| `DATA_ROOM_MAX_FILE_BYTES` | `26214400` |
| `DB_POOL_MAX` | Optional; default is `5` |

The backend verifies the bearer token signature through the Auth0 JWKS endpoint and checks the issuer, audience, expiry, and subject. Founder and Investor Relations permissions are derived only from verified role claims; email addresses submitted by a browser do not grant administrator access.

## PostgreSQL and S3 setup

Run `backend/sql/001_initial.sql` against the approved PostgreSQL database using the normal controlled migration process. Confirm that the database policy permits the required `pgcrypto` extension. The schema covers data-room documents, access grants, append-only audit events, and upload intents.

The S3 bucket must remain private, encrypted, versioned, and protected by public-access-block settings. The Lambda execution role requires only the S3 permissions needed to create presigned upload and download URLs and to inspect the relevant objects. The SAM template also configures a bucket policy that denies insecure transport.

## Deployment sequence

1. Provision the PostgreSQL database and protected secret/configuration entries.
2. Deploy `template.yaml` with `Auth0Issuer`, `Auth0Audience`, `DataRoomOrigin`, `DatabaseUrl`, and, if desired, `DataRoomS3BucketName` parameters.
3. Apply `backend/sql/001_initial.sql` to the provisioned database.
4. Record the API Gateway output URL.
5. Set `VITE_DATA_ROOM_API_BASE_URL` to that API Gateway URL and build the frontend with the verified Auth0 values.
6. Publish the Vite `dist/` directory to the AWS frontend hosting layer serving `https://investors.deeptrack.io/`.
7. Confirm DNS, TLS, CloudFront or equivalent cache behavior, and the Auth0 callback flow.
8. Add approved investor users and role claims through Auth0. Test one investor account and one administrator account separately.
9. Test health, authenticated document listing, denied tier access, presigned upload, document creation, and presigned download. Confirm that audit rows are written for each protected operation.

## Validation checklist

| Check | Expected result |
|---|---|
| `GET /health` | HTTP 200 with `ok: true` |
| Unauthenticated `/documents` | Rejected with an authentication error |
| Valid Auth0 token with the data-room audience | Accepted after issuer, signature, expiry, and role checks |
| Investor role | Tier-1 read access only; no upload or publication route |
| Founder or Investor Relations role | Administrator routes available according to policy |
| S3 object access | Only through short-lived presigned URLs; bucket remains private |
| CORS | Requests from `https://investors.deeptrack.io` permitted; other origins rejected |
| Local review mode | Available only when the API base URL is intentionally empty |

## Repository verification completed

The following commands completed successfully in the sandbox:

```text
npm run build
cd backend && npm run build
```

The next deployment-specific input still required from DevOps is the deployed API Gateway base URL. Once available, it should replace the placeholder in the production frontend environment without changing the Auth0 domain, SPA client ID, API audience, or production origin values above.
