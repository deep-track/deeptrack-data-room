# Deeptrack Data Room — AWS Migration Runbook

## Target architecture

The production data room is designed as an AWS-native system:

| Component | AWS service / implementation | Responsibility |
|---|---|---|
| Frontend | S3 static website behind CloudFront, or approved AWS static hosting | Serves the Vite React application over HTTPS. |
| API | API Gateway HTTP API + Lambda Node.js 20 | Authenticated documents, upload intents, metadata writes, and download URLs. |
| Authentication | Existing Auth0 tenant and application | Issues JWTs; the Lambda verifies issuer, audience, expiry, and role claims. |
| File storage | Private S3 bucket | Encrypted, versioned storage with public access blocked. |
| Metadata and audit | PostgreSQL, preferably RDS/Aurora PostgreSQL | Documents, versions, grants, NDA acknowledgements, upload intents, and audit events. |
| Secrets | AWS Secrets Manager / protected Lambda configuration | Database URL, Auth0 values, and other server-only secrets. |
| Monitoring | CloudWatch Logs and alarms | API errors, latency, rejected access, and operational alerts. |

The migration intentionally keeps the browser away from cloud credentials, database credentials, S3 bucket names where not required, long-lived file URLs, and access-code comparisons.

## Repository layout

```text
backend/
  src/auth.ts       Auth0 JWT verification and role mapping
  src/db.ts         PostgreSQL pool and document/audit queries
  src/handler.ts    Lambda HTTP API route handler
  src/storage.ts    Private S3 presigned upload/download URLs
  src/types.ts      Shared backend domain types
  sql/001_initial.sql PostgreSQL schema
frontend:           Existing Vite React application under src/
template.yaml:     AWS SAM infrastructure template
```

## Required AWS resources

Create or confirm the following before cutover:

1. A private S3 bucket with Block Public Access enabled, default encryption, versioning, a lifecycle rule for incomplete uploads, and a bucket policy denying insecure transport.
2. A PostgreSQL database reachable by the Lambda function. If the database is private, place the Lambda in the correct VPC subnets and security group, or use an approved RDS connectivity pattern. Do not expose the database publicly merely to simplify deployment.
3. API Gateway HTTP API routes for `/health`, `/documents`, `/uploads`, and `/documents/{id}/download`.
4. An Auth0 API audience and issuer matching the values configured in the Lambda environment.
5. A CloudFront distribution and TLS certificate for the approved data-room domain.
6. CloudWatch log retention and alarms for Lambda errors, API 5xx responses, and abnormal denial rates.

## Environment variables

The Lambda requires:

```text
AUTH0_ISSUER=https://<tenant>.<region>.auth0.com
AUTH0_AUDIENCE=https://<auth0-api-identifier>
AUTH0_ROLE_CLAIM=https://deeptrack.io/roles
AUTH0_COMPANY_ID_CLAIM=https://deeptrack.io/company_id
DATA_ROOM_ORIGIN=https://<approved-data-room-domain>
DATA_ROOM_S3_BUCKET=<private-bucket-name>
DATABASE_URL=<PostgreSQL connection string held in protected configuration>
DATABASE_SSL=true
DATA_ROOM_MAX_FILE_BYTES=26214400
```

Do not commit `DATABASE_URL`, Auth0 client secrets, S3 credentials, or any access token. Prefer Secrets Manager and inject only the required secret into the Lambda runtime.

## PostgreSQL migration

Run `backend/sql/001_initial.sql` against the approved database using a controlled migration process. Confirm that the `pgcrypto` extension is allowed by the database policy. The schema creates documents, access grants, audit events, and upload intents. Audit events are append-only at the application level; database permissions should prevent ordinary application roles from deleting or updating them.

## Build and deploy

From the repository root:

```bash
npm ci
npm run build

cd backend
npm ci
npm run typecheck
npm run build
cd ..

sam build --template-file template.yaml
sam deploy --guided --template-file .aws-sam/build/template.yaml
```

The guided deployment must use a protected parameter or secret workflow for `DatabaseUrl`. Do not place the database password in a committed parameter file or shell history.

After deployment, set the frontend’s `VITE_DATA_ROOM_API_BASE_URL` to the API Gateway base URL and rebuild the static frontend. The frontend must use a real Auth0 session/token flow in production; the current browser-only review login is not a security boundary.

## Production acceptance checklist

| Check | Pass condition |
|---|---|
| Auth0 issuer and audience | A valid Auth0 JWT is accepted; wrong issuer/audience is rejected. |
| Role enforcement | Founder and Investor Relations can administer; Investor is read-only. |
| Clearance enforcement | An investor cannot list or download documents above the assigned tier. |
| NDA enforcement | An investor without current NDA acknowledgement cannot receive document URLs. |
| Invitation expiry | Expired or revoked grants cannot access the data room. |
| Private storage | Direct unauthorised S3 access fails; objects are not public. |
| Upload intent | Intent is short-lived, owner-bound, size-checked, content-type-checked, and single-use. |
| Download URL | URL is short-lived, object-scoped, and issued only after server checks. |
| Audit trail | Login, denial, NDA, view, upload, publication, download, and access changes are recorded server-side. |
| Tenant isolation | Changing browser parameters cannot reveal another firm’s documents. |
| Version history | New uploads do not overwrite prior versions silently. |
| Logging | No secrets, tokens, identity documents, or raw provider exceptions appear in logs. |
| Recovery | Previous frontend and API artifacts are available for rollback. |

## Current implementation boundary

The AWS software implementation is now present in the repository, including the real Auth0 browser integration, authenticated access-status and NDA acknowledgement endpoints, database-backed grant checks for document listing and downloads, upload-intent consumption, document status/version endpoints, and audit retrieval. The frontend uses the remote API adapter whenever `VITE_DATA_ROOM_API_BASE_URL` is configured and presents the NDA acknowledgement step before investor document access.

The remaining work is the production cutover and DevOps execution: configure the AWS account and region, provision PostgreSQL and networking, deploy the SAM stack, configure Secrets Manager and IAM, deploy the frontend artifact to S3/CloudFront, set the API Gateway URL in the production frontend build, verify ACM/TLS and DNS, configure CloudWatch, and complete live acceptance tests with non-sensitive test documents.
