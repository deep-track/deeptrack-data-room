import type { DataRoomDocument, DataRoomRepository, NewDocument } from "../types";

let accessTokenProvider: (() => Promise<string>) | undefined;

export function configureAccessTokenProvider(provider?: () => Promise<string>) {
  accessTokenProvider = provider;
}

const DATABASE_NAME = "deeptrack-data-room-local";
const DATABASE_VERSION = 1;
const DOCUMENT_STORE = "documents";
const FILE_STORE = "files";

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Unable to open local data-room storage."));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DOCUMENT_STORE)) database.createObjectStore(DOCUMENT_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(FILE_STORE)) database.createObjectStore(FILE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("Local data-room storage request failed."));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error ?? new Error("Local data-room storage transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Local data-room storage transaction was aborted."));
    transaction.oncomplete = () => resolve();
  });
}

function recordFrom(input: NewDocument, overrides: Partial<DataRoomDocument> = {}): DataRoomDocument {
  const now = new Date().toISOString();
  return {
    ...input,
    id: randomId("doc"),
    createdAt: now,
    updatedAt: now,
    versions: [{ version: "1.0", createdAt: now, note: "Initial filing" }],
    ...overrides,
  };
}

export class LocalDataRoomRepository implements DataRoomRepository {
  async getAccessStatus() {
    return { role: "founder" as const, clearanceTier: 3 as const };
  }

  async acknowledgeNda(version: string) {
    return { acknowledged: true, version };
  }

  async listDocuments(): Promise<DataRoomDocument[]> {
    const database = await openDatabase();
    const transaction = database.transaction(DOCUMENT_STORE, "readonly");
    const documents = await requestValue(transaction.objectStore(DOCUMENT_STORE).getAll() as IDBRequest<DataRoomDocument[]>);
    await transactionDone(transaction);
    return documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createUploadedDocument(input: NewDocument, file: File): Promise<DataRoomDocument> {
    const record = recordFrom(input, { fileName: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size, source: "upload" });
    const database = await openDatabase();
    const transaction = database.transaction([DOCUMENT_STORE, FILE_STORE], "readwrite");
    transaction.objectStore(DOCUMENT_STORE).put(record);
    transaction.objectStore(FILE_STORE).put(file, record.id);
    await transactionDone(transaction);
    return record;
  }

  async createLinkedDocument(input: NewDocument): Promise<DataRoomDocument> {
    const record = recordFrom(input, { source: "link" });
    const database = await openDatabase();
    const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
    transaction.objectStore(DOCUMENT_STORE).put(record);
    await transactionDone(transaction);
    return record;
  }

  async getDownloadUrl(documentId: string): Promise<string | null> {
    const database = await openDatabase();
    const transaction = database.transaction(FILE_STORE, "readonly");
    const file = await requestValue(transaction.objectStore(FILE_STORE).get(documentId) as IDBRequest<Blob | undefined>);
    await transactionDone(transaction);
    return file ? URL.createObjectURL(file) : null;
  }
}

type UploadIntent = { uploadUrl: string; storageKey: string };

/** Production adapter contract. The API must require a server-side session before issuing any URL. */
export class RemoteDataRoomRepository implements DataRoomRepository {
  constructor(private readonly apiBaseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = accessTokenProvider ? await accessTokenProvider() : undefined;
    const response = await fetch(`${this.apiBaseUrl.replace(/\/$/, "")}${path}`, { credentials: "include", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) }, ...init });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? `Data-room service returned ${response.status}.`);
    }
    return response.json() as Promise<T>;
  }

  listDocuments() { return this.request<DataRoomDocument[]>("/documents"); }

  getAccessStatus() { return this.request<import("../types").AccessStatus>("/access/status"); }

  acknowledgeNda(version: string) {
    return this.request<{ acknowledged: boolean; version: string }>("/access/nda", { method: "POST", body: JSON.stringify({ version }) });
  }

  async createUploadedDocument(document: NewDocument, file: File): Promise<DataRoomDocument> {
    const intent = await this.request<UploadIntent>("/uploads", { method: "POST", body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream", contentLength: file.size, category: document.category, tier: document.tier }) });
    const upload = await fetch(intent.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
    if (!upload.ok) throw new Error("The private storage upload did not complete. Please retry the document filing action.");
    return this.request<DataRoomDocument>("/documents", { method: "POST", body: JSON.stringify({ ...document, storageKey: intent.storageKey, fileName: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size }) });
  }

  createLinkedDocument(document: NewDocument) { return this.request<DataRoomDocument>("/documents", { method: "POST", body: JSON.stringify(document) }); }

  async getDownloadUrl(documentId: string): Promise<string | null> {
    const result = await this.request<{ url: string }>(`/documents/${encodeURIComponent(documentId)}/download`);
    return result.url;
  }
}

const apiBaseUrl = import.meta.env.VITE_DATA_ROOM_API_BASE_URL?.trim();
export const dataRoomRepository: DataRoomRepository = apiBaseUrl ? new RemoteDataRoomRepository(apiBaseUrl) : new LocalDataRoomRepository();

export function formatBytes(bytes?: number) {
  if (bytes === undefined) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
