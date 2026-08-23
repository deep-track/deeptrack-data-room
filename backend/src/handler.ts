import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { randomUUID } from "node:crypto";
import { requireAuth } from "./auth.js";
import { getDocument, insertAudit, insertDocument, listApprovedDocuments, query, withTransaction } from "./db.js";
import { createDownloadUrl, createUploadUrl, validateUpload } from "./storage.js";

const headers = {
  "content-type": "application/json",
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

function response(statusCode: number, body: unknown): APIGatewayProxyResultV2 { return { statusCode, headers, body: JSON.stringify(body) }; }
function jsonBody(event: APIGatewayProxyEventV2) { return event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : {}; }
function clientMeta(event: APIGatewayProxyEventV2) { return { ip: event.requestContext.http.sourceIp, userAgent: event.headers["user-agent"] || event.headers["User-Agent"] }; }
function errorResponse(error: unknown) { const message = error instanceof Error ? error.message : "Request failed"; const auth = /Authentication|required|role|Authenticated|forbidden/i.test(message); return response(auth ? 403 : 500, { error: auth ? message : "Data-room service unavailable" }); }

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath.replace(/^\/api/, "").replace(/\/$/, "") || "/";
    if (method === "OPTIONS") return { statusCode: 204, headers: { ...headers, "access-control-allow-origin": process.env.DATA_ROOM_ORIGIN || "", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,OPTIONS" }, body: "" };
    if (path === "/health" && method === "GET") return response(200, { ok: true, service: "deeptrack-data-room-api" });

    const adminRoute = method === "POST" && (path === "/uploads" || path === "/documents");
    const auth = await requireAuth(event, adminRoute ? "admin" : "any");
    const meta = clientMeta(event);

    if (path === "/documents" && method === "GET") {
      const documents = await listApprovedDocuments(auth.clearanceTier);
      await insertAudit({ event: "document_list", actorSubject: auth.subject, actorEmail: auth.email, detail: `count=${documents.length}`, ...meta, createdAt: new Date().toISOString() });
      return response(200, documents);
    }

    if (path === "/uploads" && method === "POST") {
      const body = jsonBody(event) as { fileName?: string; contentType?: string; contentLength?: number; category?: string; tier?: number };
      const fileName = String(body.fileName || ""); const contentType = String(body.contentType || "application/octet-stream"); const contentLength = Number(body.contentLength);
      validateUpload(fileName, contentType, contentLength);
      const tier = Number(body.tier); if (![1,2,3].includes(tier)) throw new Error("Invalid clearance tier");
      const intentId = randomUUID(); const storageKey = `documents/${new Date().toISOString().slice(0,10)}/${intentId}/${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await query("INSERT INTO data_room_upload_intents (id,storage_key,owner_subject,content_type,content_length,expires_at) VALUES ($1,$2,$3,$4,$5,$6)", [intentId,storageKey,auth.subject,contentType,contentLength,expiresAt]);
      await insertAudit({ event: "upload_intent_created", actorSubject: auth.subject, actorEmail: auth.email, detail: `intent=${intentId};tier=${tier}`, ...meta, createdAt: new Date().toISOString() });
      return response(201, { uploadUrl: await createUploadUrl(storageKey, contentType), storageKey, intentId, expiresAt });
    }

    if (path === "/documents" && method === "POST") {
      const body = jsonBody(event) as Record<string, unknown>;
      const title = String(body.title || "").trim(); const category = String(body.category || "").trim(); const source = body.source === "link" ? "link" : "upload";
      const tier = Number(body.tier); if (!title || !category || ![1,2,3].includes(tier)) throw new Error("Title, category, and valid clearance tier are required");
      let storageKey = typeof body.storageKey === "string" ? body.storageKey : undefined;
      if (source === "upload") {
        if (!storageKey) throw new Error("Uploaded documents require a storage key");
        const intent = await query<{ owner_subject: string; expires_at: string; consumed_at: string | null }>("SELECT owner_subject, expires_at, consumed_at FROM data_room_upload_intents WHERE storage_key=$1", [storageKey]);
        const row = intent.rows[0]; if (!row || row.owner_subject !== auth.subject || row.consumed_at || new Date(row.expires_at) < new Date()) throw new Error("Upload intent is invalid or expired");
        await query("UPDATE data_room_upload_intents SET consumed_at=now() WHERE storage_key=$1", [storageKey]);
      } else {
        const link = String(body.link || ""); if (!/^https:\/\//i.test(link)) throw new Error("Linked documents require an HTTPS URL");
      }
      const document = await withTransaction(async () => insertDocument({ id: randomUUID(), title, category, tier, description: typeof body.description === "string" ? body.description : undefined, source, link: typeof body.link === "string" ? body.link : undefined, storageKey, fileName: typeof body.fileName === "string" ? body.fileName : undefined, mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined, sizeBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : undefined, ownerSubject: auth.subject, status: "approved" }));
      await insertAudit({ event: "document_created", actorSubject: auth.subject, actorEmail: auth.email, documentId: document.id, detail: `status=${document.status};tier=${document.tier}`, ...meta, createdAt: new Date().toISOString() });
      return response(201, document);
    }

    const match = path.match(/^\/documents\/([^/]+)\/download$/);
    if (match && method === "GET") {
      const document = await getDocument(match[1]); if (!document || document.status !== "approved" || document.tier > auth.clearanceTier) return response(404, { error: "Document not available" });
      if (document.source === "link" && document.link) return response(200, { url: document.link });
      if (!document.storageKey) return response(404, { error: "Document file unavailable" });
      const url = await createDownloadUrl(document.storageKey, document.fileName);
      await insertAudit({ event: "document_download_url_created", actorSubject: auth.subject, actorEmail: auth.email, documentId: document.id, ...meta, createdAt: new Date().toISOString() });
      return response(200, { url });
    }

    return response(404, { error: "Not found" });
  } catch (error) { console.error("data-room-api-error", error instanceof Error ? error.message : "unknown"); return errorResponse(error); }
}
