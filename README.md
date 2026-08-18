# Deeptrack Data Room

This project is the TypeScript migration of the Deeptrack fundraising data room. It provides a typed React interface for document folders, clearance tiers, document records, version history, reliable local upload/download testing, and a production adapter for server-authorized private storage.

## Local review mode

Local review mode is deliberately enabled when `VITE_DATA_ROOM_API_BASE_URL` is not set. It uses browser IndexedDB so the interface can be tested without real cloud credentials or real fundraising documents. Documents stored this way remain only in that browser; they are not secure multi-user storage and must not be treated as a production data room.

```bash
npm install
npm run dev
npm run build
```

## Production mode

Set `VITE_DATA_ROOM_API_BASE_URL` to an authenticated server-side data-room API. The client then expects the API to authorize document listings, short-lived private upload URLs, document metadata creation, and short-lived private download URLs.

Read the following documents before deployment:

| Document | Purpose |
|---|---|
| `DATA_ROOM_AUDIT.md` | Findings from the original HTML/JavaScript implementation. |
| `TYPESCRIPT_MIGRATION_ARCHITECTURE.md` | The chosen TypeScript and private-storage design. |
| `PRODUCTION_STORAGE_SETUP.md` | Required AWS S3, metadata, authentication, and API controls. |
| `ROLE_AND_CONTROL_MODEL.md` | Founder, Investor Relations Officer, and Investor permissions plus comprehensive governance controls. |
| `DATA_ROOM_VALIDATION.md` | Build and browser smoke-test evidence. |

## Security boundary

The browser bundle contains no cloud credentials, no default investor access codes, and no public document URL generation. Production requires server-side session checks, Founder / Investor Relations / Investor role enforcement, clearance enforcement, private object storage, append-only audit events, and short-lived presigned URLs as described in `PRODUCTION_STORAGE_SETUP.md` and `ROLE_AND_CONTROL_MODEL.md`.
