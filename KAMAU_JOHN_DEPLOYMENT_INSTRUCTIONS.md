# Deeptrack Investor Data Room
## AWS Deployment Instructions for Kamau John

**To:** Kamau John, DevOps Engineer  
**Repository:** https://github.com/deep-track/deeptrack-data-room  
**Branch:** `main`  
**Current commit:** `8a1b99a` — Ignore placeholder Auth0 organization; production Auth0/API configuration verified  
**Production frontend:** https://investors.deeptrack.io/

## 1. Objective

Please deploy the Deeptrack Investor Data Room as an AWS-native application. The frontend is a Vite React single-page application. The backend is a Node.js 20 AWS Lambda function exposed through an API Gateway HTTP API. PostgreSQL stores all document metadata, access grants, upload intents, and audit events. Private S3 stores document files and is accessed only through short-lived presigned URLs.

Do not deploy this application to Vercel. Do not put database credentials, AWS credentials, Auth0 client secrets, or S3 credentials in the frontend or Git repository.

## 2. Repository setup

Clone the repository and use the `main` branch:

```bash
git clone https://github.com/deep-track/deeptrack-data-room.git
cd deeptrack-data-room
git checkout main
git pull origin main
```

Confirm that the checked-out commit is `2e42791` or a later approved commit.

The AWS infrastructure definition is `template.yaml`. The Lambda source and PostgreSQL/S3 implementation are under `backend/`. The database migration is `backend/sql/001_initial.sql`.

## 3. Auth0 values

The Auth0 resources have already been created and configured. Use these values exactly:

| Setting | Value |
|---|---|
| Auth0 tenant domain | `dev-08kwsss3wr77v0k0.us.auth0.com` |
| Issuer | `https://dev-08kwsss3wr77v0k0.us.auth0.com/` |
| Data Room API audience | `https://api.deeptrack.io/data-room` |
| JWT signing algorithm | RS256 |
| SPA name | `Deeptrack Data Room` |
| SPA client ID | `2nsfWPfcCPkxA3N7Me4aUwjlSsDeoFbM` |
| Role claim | `https://deeptrack.io/roles` |
| Production origin | `https://investors.deeptrack.io` |

Auth0 application settings already contain:

```text
Allowed Callback URL: https://investors.deeptrack.io/
Allowed Logout URL: https://investors.deeptrack.io/
Allowed Web Origin: https://investors.deeptrack.io
Allowed CORS Origin: https://investors.deeptrack.io
```

Do not use the existing Sentinel client ID for this data room. Do not create a client secret for the SPA.

## 4. PostgreSQL

Provision a production PostgreSQL database that is reachable from the Lambda function. Place the connection string in AWS Secrets Manager or the approved protected deployment configuration; do not commit it to Git.

Apply the schema using the controlled database migration process:

```bash
psql "$DATABASE_URL" -f backend/sql/001_initial.sql
```

The migration creates the following data-room tables:

| Table | Purpose |
|---|---|
| `data_room_documents` | Document metadata, classification, status, and storage references |
| `data_room_access_grants` | Investor/company clearance grants |
| `data_room_audit_events` | Append-only audit trail for protected operations |
| `data_room_upload_intents` | Short-lived upload authorization records |

Confirm that the database policy permits the required `pgcrypto` extension. Use TLS for the database connection. The Lambda connection pool defaults to a maximum of five connections; keep the pool conservative for the selected PostgreSQL capacity.

## 5. AWS deployment

Install and configure the AWS CLI and AWS SAM CLI using the company’s approved AWS account and region. From the repository root, build and deploy the SAM application:

```bash
cd deeptrack-data-room
sam build --template-file template.yaml
sam deploy --guided --template-file .aws-sam/build/template.yaml
```

Use the following parameter values during deployment:

| SAM parameter | Value |
|---|---|
| `Auth0Issuer` | `https://dev-08kwsss3wr77v0k0.us.auth0.com/` |
| `Auth0Audience` | `https://api.deeptrack.io/data-room` |
| `DataRoomOrigin` | `https://investors.deeptrack.io` |
| `DatabaseUrl` | Protected PostgreSQL connection string |
| `DataRoomS3BucketName` | Optional; use a controlled globally unique name if required |

Recommended deployment settings:

```text
Stack name: deeptrack-investor-data-room
Confirm changeset: Yes
Allow SAM CLI IAM role creation: Yes, subject to account policy
Disable rollback: No
Save arguments to configuration: Yes, but keep secrets out of committed files
```

The stack creates an HTTP API, a Node.js 20 Lambda function, a private encrypted/versioned S3 bucket, an S3 bucket policy denying insecure transport, and the required Lambda S3 permissions.

After deployment, retrieve the API output:

```bash
aws cloudformation describe-stacks \
  --stack-name deeptrack-investor-data-room \
  --query 'Stacks[0].Outputs' \
  --output table
```

Record the `ApiUrl` output. It will be similar to:

```text
https://<api-id>.execute-api.<aws-region>.amazonaws.com
```

## 6. Lambda configuration

Ensure the Lambda runtime receives these variables. The SAM template supplies the core values; protected configuration should supply the database connection string.

```text
AUTH0_ISSUER=https://dev-08kwsss3wr77v0k0.us.auth0.com/
AUTH0_AUDIENCE=https://api.deeptrack.io/data-room
AUTH0_ROLE_CLAIM=https://deeptrack.io/roles
AUTH0_COMPANY_ID_CLAIM=https://deeptrack.io/company_id
DATA_ROOM_ORIGIN=https://investors.deeptrack.io
DATABASE_SSL=true
DATA_ROOM_MAX_FILE_BYTES=26214400
DATA_ROOM_S3_BUCKET=<private bucket name>
DATABASE_URL=<protected PostgreSQL connection string>
```

The backend validates the bearer token issuer, audience, signature, expiry, subject, and role claim through the Auth0 JWKS endpoint. Founder and Investor Relations privileges must come only from verified role claims. Never implement administrator access based on an email address supplied by the browser.

## 7. Frontend deployment

After the API Gateway URL is available, create the production frontend environment configuration. Use the verified Auth0 values and the deployed API URL:

```text
VITE_AUTH0_DOMAIN=dev-08kwsss3wr77v0k0.us.auth0.com
VITE_AUTH0_CLIENT_ID=2nsfWPfcCPkxA3N7Me4aUwjlSsDeoFbM
VITE_AUTH0_AUDIENCE=https://api.deeptrack.io/data-room
VITE_AUTH0_ROLE_CLAIM=https://deeptrack.io/roles
VITE_DATA_ROOM_API_BASE_URL=https://<api-id>.execute-api.<aws-region>.amazonaws.com
```

Then build the static frontend:

```bash
npm ci
npm run build
```

Publish the generated `dist/` directory through the approved AWS frontend hosting layer, normally an S3 static origin behind CloudFront or the organization’s equivalent AWS-native service. Configure the custom domain `investors.deeptrack.io` with TLS and ensure SPA history fallback serves `index.html` for application routes.

The current code keeps local review mode available when `VITE_DATA_ROOM_API_BASE_URL` is empty. Do not leave the production build with an empty API base URL.

## 8. DNS and TLS

Point `investors.deeptrack.io` to the deployed AWS frontend distribution. Use the organization’s DNS and certificate process. Confirm that:

1. HTTPS is enforced.
2. The certificate covers `investors.deeptrack.io`.
3. The root application loads successfully.
4. SPA routes do not return a CloudFront/S3 404 after a browser refresh.
5. Auth0 redirects return to the exact URL configured in the Auth0 dashboard.

## 9. Required tests

Run these checks after deployment:

```bash
curl -i "https://<api-id>.execute-api.<aws-region>.amazonaws.com/health"
```

Expected result: HTTP 200 and a JSON response containing `"ok":true`.

Then test through the live frontend:

| Test | Expected result |
|---|---|
| Open `https://investors.deeptrack.io/` | Application loads over HTTPS |
| Sign in with an approved investor | Auth0 login succeeds and investor view loads |
| Investor requests a restricted document tier | Document is not disclosed |
| Investor attempts upload or publication | Request is rejected |
| Founder or Investor Relations user signs in | Administrator controls are available according to role |
| Approved user downloads a permitted file | Short-lived presigned S3 URL is returned |
| Direct public S3 object access | Denied; bucket remains private |
| Request from an unauthorized origin | CORS request rejected |
| Database audit review | List, upload-intent, document-create, and download events are recorded |
| Invalid, expired, or wrong-audience JWT | Request is rejected |

## 10. Security requirements

Use least-privilege IAM. The Lambda role should have only the S3 access required for the data-room bucket and the logging permissions required by the runtime. Store PostgreSQL credentials in Secrets Manager or the approved protected configuration system. Enable CloudWatch logging, alarms for Lambda errors and API 5xx responses, and appropriate API throttling.

Do not enable public S3 access. Do not expose the PostgreSQL endpoint unnecessarily. Do not commit `.env` files, database URLs, private keys, Auth0 secrets, or AWS credentials. The committed `.env.example` contains only public SPA values and placeholders.

## 11. Information to return after deployment

Please send back the following values and confirmations:

| Item | Required response |
|---|---|
| AWS region | Region used for the stack |
| CloudFormation stack | Stack name and status |
| API Gateway URL | Exact `ApiUrl` output |
| Lambda | Function name and successful health test |
| PostgreSQL | Migration applied successfully; no credentials in the response |
| S3 | Bucket name and confirmation that public access is blocked |
| Frontend | Hosting distribution and HTTPS status |
| DNS/TLS | Confirmation that `investors.deeptrack.io` resolves correctly |
| Auth0 flow | Successful login test and callback confirmation |
| Security tests | Results for investor/admin authorization and denied access tests |

The immediate dependency for the frontend release is the **API Gateway URL**. Once that URL is available, it must be placed in `VITE_DATA_ROOM_API_BASE_URL`, followed by a fresh production build and frontend deployment.
