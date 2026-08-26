import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { randomUUID } from "node:crypto";
import { requireAuth } from "./auth.js";
import { acknowledgeNda, addDocumentVersion, getActiveGrant, getDocument, insertAudit, insertDocument, listAccessGrants, listApprovedDocuments, listAuditEvents, markUploadIntentConsumed, query, revokeAccessGrant, updateDocumentStatus, upsertAccessGrant, withTransaction } from "./db.js";
import { createDownloadUrl, createUploadUrl, validateUpload } from "./storage.js";

const headers = {
  "content-type": "application/json",
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

function response(statusCode: number, body: unknown): APIGatewayProxyResultV2 { return { statusCode, headers, body: JSON.stringify(body) }; }
function jsonBody(event: APIGatewayProxyEventV2) { try { return event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : {}; } catch { throw new Error("Request body must be valid JSON"); } }
function clientMeta(event: APIGatewayProxyEventV2) { return { ip: event.requestContext.http.sourceIp, userAgent: event.headers["user-agent"] || event.headers["User-Agent"] }; }
function errorResponse(error: unknown) { const message = error instanceof Error ? error.message : "Request failed"; const auth = /Authentication|required|role|Authenticated|forbidden|NDA|grant|clearance|expired|revoked/i.test(message); return response(auth ? 403 : 500, { error: auth ? message : "Data-room service unavailable" }); }
function idFrom(path: string, pattern: RegExp) { const match = path.match(pattern); return match?.[1]; }

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath.replace(/^\/api/, "").replace(/\/$/, "") || "/";
    if (method === "OPTIONS") return { statusCode: 204, headers: { ...headers, "access-control-allow-origin": process.env.DATA_ROOM_ORIGIN || "", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,OPTIONS" }, body: "" };
    if (path === "/health" && method === "GET") return response(200, { ok: true, service: "deeptrack-data-room-api" });

    const adminRoute = (method === "POST" && (path === "/uploads" || path === "/documents" || path === "/access/grants")) || (method === "GET" && (path === "/access/grants" || path === "/audit")) || (method === "POST" && /^\/access\/grants\/[^/]+\/revoke$/.test(path)) || (method === "POST" && /^\/documents\/[^/]+\/(status|versions)$/.test(path));
    const auth = await requireAuth(event, adminRoute ? "admin" : "any");
    const meta = clientMeta(event);

    if (path === "/access/status" && method === "GET") {
      const grant = auth.role === "investor" ? await getActiveGrant(auth.subject) : undefined;
      if (auth.role === "investor" && !grant) throw new Error("No active data-room grant is assigned");
      return response(200, { role: auth.role, clearanceTier: grant?.clearanceTier ?? auth.clearanceTier, grant: grant ? { investorEmail: grant.investorEmail, firmName: grant.firmName, clearanceTier: grant.clearanceTier, ndaVersion: grant.ndaVersion, ndaAcknowledgedAt: grant.ndaAcknowledgedAt, expiresAt: grant.expiresAt } : undefined });
    }

    if (path === "/documents" && method === "GET") {
      let clearanceTier = auth.clearanceTier;
      if (auth.role === "investor") {
        const grant = await getActiveGrant(auth.subject);
        if (!grant) throw new Error("No active data-room grant is assigned");
        if (!grant.ndaAcknowledgedAt) throw new Error("Current NDA acknowledgement is required");
        clearanceTier = grant.clearanceTier;
      }
      const documents = await listApprovedDocuments(clearanceTier);
      await insertAudit({ event: "document_list", actorSubject: auth.subject, actorEmail: auth.email, detail: `count=${documents.length};tier=${clearanceTier}`, ...meta, createdAt: new Date().toISOString() });
      return response(200, documents);
    }

    if (path === "/access/grants" && method === "GET") return response(200, await listAccessGrants());

    if (path === "/access/grants" && method === "POST") {
      const body = jsonBody(event) as Record<string, unknown>;
      const investorSubject = String(body.investorSubject || "").trim();
      const investorEmail = String(body.investorEmail || "").trim().toLowerCase();
      const clearanceTier = Number(body.clearanceTier);
      const ndaVersion = String(body.ndaVersion || "").trim();
      const expiresAt = String(body.expiresAt || "");
      if (!investorSubject || !/^\S+@\S+\.\S+$/.test(investorEmail) || ![1, 2, 3].includes(clearanceTier) || !ndaVersion || !expiresAt || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw new Error("Valid investor, clearance, NDA version, and future expiry are required");
      const grant = await upsertAccessGrant({ investorSubject, investorEmail, firmName: typeof body.firmName === "string" ? body.firmName.trim() : undefined, clearanceTier, ndaVersion, expiresAt, createdBySubject: auth.subject });
      await insertAudit({ event: "access_grant_created", actorSubject: auth.subject, actorEmail: auth.email, detail: `investor=${investorSubject};tier=${clearanceTier};expires=${expiresAt}`, ...meta, createdAt: new Date().toISOString() });
      return response(201, grant);
    }

    if (path === "/access/nda" && method === "POST") {
      if (auth.role !== "investor") throw new Error("NDA acknowledgement is only available to investor identities");
      const body = jsonBody(event) as { version?: string };
      const version = String(body.version || "").trim();
      if (!version) throw new Error("NDA version is required");
      if (!(await acknowledgeNda(auth.subject, version))) throw new Error("No active grant is available for this identity");
      await insertAudit({ event: "nda_acknowledged", actorSubject: auth.subject, actorEmail: auth.email, detail: `version=${version}`, ...meta, createdAt: new Date().toISOString() });
      return response(200, { acknowledged: true, version });
    }

    const revokeId = idFrom(path, /^\/access\/grants\/([^/]+)\/revoke$/);
    if (revokeId && method === "POST") {
      if (!(await revokeAccessGrant(revokeId, auth.subject))) return response(404, { error: "Grant not found" });
      await insertAudit({ event: "access_grant_revoked", actorSubject: auth.subject, actorEmail: auth.email, detail: `grant=${revokeId}`, ...meta, createdAt: new Date().toISOString() });
      return response(200, { revoked: true });
    }

    if (path === "/audit" && method === "GET") {
      const requested = Number(event.queryStringParameters?.limit || 100);
      return response(200, await listAuditEvents(Number.isFinite(requested) ? requested : 100));
    }

    if (path === "/uploads" && method === "POST") {
      const body = jsonBody(event) as { fileName?: string; contentType?: string; contentLength?: number; category?: string; tier?: number };
      const fileName = String(body.fileName || ""); const contentType = String(body.contentType || "application/octet-stream"); const contentLength = Number(body.contentLength);
      validateUpload(fileName, contentType, contentLength);
      const tier = Number(body.tier); if (![1, 2, 3].includes(tier)) throw new Error("Invalid clearance tier");
      const intentId = randomUUID(); const storageKey = `documents/${new Date().toISOString().slice(0, 10)}/${intentId}/${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await query("INSERT INTO data_room_upload_intents (id,storage_key,owner_subject,content_type,content_length,expires_at) VALUES ($1,$2,$3,$4,$5,$6)", [intentId, storageKey, auth.subject, contentType, contentLength, expiresAt]);
      await insertAudit({ event: "upload_intent_created", actorSubject: auth.subject, actorEmail: auth.email, detail: `intent=${intentId};tier=${tier}`, ...meta, createdAt: new Date().toISOString() });
      return response(201, { uploadUrl: await createUploadUrl(storageKey, contentType), storageKey, intentId, expiresAt });
    }

    if (path === "/documents" && method === "POST") {
      const body = jsonBody(event) as Record<string, unknown>;
      const title = String(body.title || "").trim(); const category = String(body.category || "").trim(); const source = body.source === "link" ? "link" : "upload";
      const tier = Number(body.tier); if (!title || !category || ![1, 2, 3].includes(tier)) throw new Error("Title, category, and valid clearance tier are required");
      const storageKey = typeof body.storageKey === "string" ? body.storageKey : undefined;
      if (source === "link") {
        const link = String(body.link || ""); if (!/^https:\/\//i.test(link)) throw new Error("Linked documents require an HTTPS URL");
      }
      const document = await withTransaction(async (client) => {
        if (source === "upload") {
          if (!storageKey) throw new Error("Uploaded documents require a storage key");
          const intent = await client.query<{ owner_subject: string; expires_at: string; consumed_at: string | null }>("SELECT owner_subject, expires_at, consumed_at FROM data_room_upload_intents WHERE storage_key=$1 FOR UPDATE", [storageKey]);
          const row = intent.rows[0]; if (!row || row.owner_subject !== auth.subject || row.consumed_at || new Date(row.expires_at) < new Date()) throw new Error("Upload intent is invalid or expired");
          if (!(await markUploadIntentConsumed(storageKey, auth.subject, client))) throw new Error("Upload intent is invalid or already consumed");
        }
        return insertDocument({ id: randomUUID(), title, category, tier, description: typeof body.description === "string" ? body.description : undefined, source, link: typeof body.link === "string" ? body.link : undefined, storageKey, fileName: typeof body.fileName === "string" ? body.fileName : undefined, mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined, sizeBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : undefined, ownerSubject: auth.subject, status: "approved" }, client);
      });
      await insertAudit({ event: "document_created", actorSubject: auth.subject, actorEmail: auth.email, documentId: document.id, detail: `status=${document.status};tier=${document.tier}`, ...meta, createdAt: new Date().toISOString() });
      return response(201, document);
    }

    const statusId = idFrom(path, /^\/documents\/([^/]+)\/status$/);
    if (statusId && method === "POST") {
      const body = jsonBody(event) as { status?: string };
      const status = body.status;
      if (!status || !["draft", "review", "approved", "withdrawn"].includes(status)) throw new Error("Invalid document status");
      const document = await updateDocumentStatus(statusId, status as "draft" | "review" | "approved" | "withdrawn", auth.subject);
      if (!document) return response(404, { error: "Document not found" });
      await insertAudit({ event: "document_status_changed", actorSubject: auth.subject, actorEmail: auth.email, documentId: statusId, detail: `status=${status}`, ...meta, createdAt: new Date().toISOString() });
      return response(200, document);
    }

    const versionId = idFrom(path, /^\/documents\/([^/]+)\/versions$/);
    if (versionId && method === "POST") {
      const body = jsonBody(event) as { note?: string };
      const note = String(body.note || "").trim(); if (!note) throw new Error("Version note is required");
      const document = await addDocumentVersion(versionId, note, auth.subject);
      if (!document) return response(404, { error: "Document not found" });
      await insertAudit({ event: "document_version_added", actorSubject: auth.subject, actorEmail: auth.email, documentId: versionId, detail: note, ...meta, createdAt: new Date().toISOString() });
      return response(200, document);
    }

    const downloadId = idFrom(path, /^\/documents\/([^/]+)\/download$/);
    if (downloadId && method === "GET") {
      const document = await getDocument(downloadId); if (!document || document.status !== "approved") return response(404, { error: "Document not available" });
      if (auth.role === "investor") {
        const grant = await getActiveGrant(auth.subject);
        if (!grant || !grant.ndaAcknowledgedAt || document.tier > grant.clearanceTier) return response(404, { error: "Document not available" });
      } else if (document.tier > auth.clearanceTier) return response(404, { error: "Document not available" });
      if (document.source === "link" && document.link) return response(200, { url: document.link });
      if (!document.storageKey) return response(404, { error: "Document file unavailable" });
      const url = await createDownloadUrl(document.storageKey, document.fileName);
      await insertAudit({ event: "document_download_url_created", actorSubject: auth.subject, actorEmail: auth.email, documentId: document.id, ...meta, createdAt: new Date().toISOString() });
      return response(200, { url });
    }

    return response(404, { error: "Not found" });
  } catch (error) { console.error("data-room-api-error", error instanceof Error ? error.message : "unknown"); return errorResponse(error); }
}
