export type ClearanceTier = 1 | 2 | 3;
export type DocumentSource = "upload" | "link";

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
  source: DocumentSource;
  link?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  description?: string;
  createdAt: string;
  updatedAt: string;
  versions: DocumentVersion[];
};

export type NewDocument = Omit<DataRoomDocument, "id" | "createdAt" | "updatedAt" | "versions">;

export type DataRoomRepository = {
  listDocuments: () => Promise<DataRoomDocument[]>;
  createUploadedDocument: (document: NewDocument, file: File) => Promise<DataRoomDocument>;
  createLinkedDocument: (document: NewDocument) => Promise<DataRoomDocument>;
  getDownloadUrl: (documentId: string) => Promise<string | null>;
};
