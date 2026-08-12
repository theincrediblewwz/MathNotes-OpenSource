export type PairingTarget = Readonly<{
  notebookId: string;
  notebookTitle?: string;
  sessionId: string;
  title: string;
}>;

export type CompanionHostCapabilities = Readonly<{
  imageUpload: boolean;
  pdfUpload: boolean;
  recognitionStatus: boolean;
  recognitionRetry: boolean;
}>;

export type CompanionCatalog = Readonly<{
  activeTarget: PairingTarget | null;
  targets: readonly PairingTarget[];
  capabilities: CompanionHostCapabilities;
}>;

export type DeviceCredential = Readonly<{
  id: "active";
  version: 1;
  origin: string;
  token: string;
  deviceId: string;
  deviceLabel: string;
  verifiedAt: string;
}>;

export type SessionAsset = Readonly<{
  id: string;
  path: string;
  mimeType: string;
}>;

export type SessionManifest = Readonly<{
  version: 2;
  notebookId: string;
  sessionId: string;
  title: string;
  revision: string;
  updatedAt: string;
  blockCount: number;
  markdownBytes: number;
  htmlBytes: number;
  assets: readonly SessionAsset[];
}>;

export type CachedCatalog = Readonly<{
  profileId: string;
  version: 1;
  activeTarget: PairingTarget | null;
  targets: readonly PairingTarget[];
  capabilities?: CompanionHostCapabilities;
  syncedAt: string;
}>;

export type CachedSession = Readonly<{
  key: string;
  profileId: string;
  version: 1;
  notebookId: string;
  sessionId: string;
  title: string;
  revision: string;
  updatedAt: string;
  blockCount: number;
  markdown: string;
  html: string;
  assets: readonly SessionAsset[];
  syncedAt: string;
}>;

export type CachedAsset = Readonly<{
  key: string;
  profileId: string;
  notebookId: string;
  sessionId: string;
  assetId: string;
  mimeType: string;
  bytes: Blob;
  syncedAt: string;
}>;

export type UploadMaterialKind = "image" | "pdf";

export type UploadTaskStatus =
  | "pending"
  | "uploading"
  | "retry_wait"
  | "failed"
  | "blocked_auth"
  | "succeeded";

export type UploadTask = Readonly<{
  id: string;
  version: 1;
  profileId: string;
  kind: UploadMaterialKind;
  fileName: string;
  mimeType: string;
  byteLength: number;
  bytes?: Blob;
  previewBytes?: Blob;
  notebookId: string;
  notebookTitle: string;
  sessionId: string;
  sessionTitle: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  status: UploadTaskStatus;
  nextAttemptAt?: string;
  lastError?: string;
  uploadId?: string;
  duplicate?: boolean;
  assetPath?: string;
  imageBlockId?: string;
  transcriptBlockId?: string;
  recognitionJobId?: string;
  recognitionStatus?: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  recognitionWarnings?: readonly string[];
}>;

export function sessionCacheKey(profileId: string, notebookId: string, sessionId: string): string {
  return [profileId, notebookId, sessionId].join("\u0000");
}

export function assetCacheKey(
  profileId: string,
  notebookId: string,
  sessionId: string,
  assetId: string
): string {
  return [profileId, notebookId, sessionId, assetId].join("\u0000");
}
