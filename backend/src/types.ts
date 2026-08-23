export type Role = "founder" | "investorRelations" | "investor";
export type ClearanceTier = 1 | 2 | 3;
export type DocumentSource = "upload" | "link";
export type DocumentStatus = "draft" | "review" | "approved" | "superseded" | "withdrawn";

export type DocumentVersion = {
  version: string;
  createdAt: string;
  note: string;
};

export type DataRoomDocument = {
  id: string;
  title: string;
  category: string;
  tier: ClearanceTier;
  description?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  source: DocumentSource;
  link?: string;
  storageKey?: string;
  status: DocumentStatus;
  ownerSubject: string;
  createdAt: string;
  updatedAt: string;
  versions: DocumentVersion[];
};

export type AuditEvent = {
  pk: string;
  sk: string;
  entityType: "AUDIT";
  event: string;
  actorSubject: string;
  actorEmail?: string;
  documentId?: string;
  detail?: string;
  ip?: string;
  userAgent?: string;
  createdAt: string;
};

export type AuthContext = {
  subject: string;
  email?: string;
  name?: string;
  role: Role;
  clearanceTier: ClearanceTier;
  companyId?: string;
};
