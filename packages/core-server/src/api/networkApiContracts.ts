import type { ImageTransformSidecar } from "@mathnotes/shared";

export type RecognitionJobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type CompanionUploadActivity = Readonly<{
  version: 1;
  notebookId: string;
  sessionId: string;
  captureId?: string;
  fileName?: string;
  receivedBytes: number;
  totalBytes?: number;
  status: "receiving" | "accepted";
  updatedAt: string;
}>;

export type IngestPhotoArgs = {
  notebookId: string;
  sessionId: string;
  originalName: string;
  mimeType: string;
  bytes: Buffer;
  sha256?: string;
  captureId?: string;
  deviceId?: string;
  insertAfterBlockId?: string;
  imageTransform?: ImageTransformSidecar;
  receivedAt: string;
};

export type IngestPhotoResult = {
  uploadId: string;
  notebookId?: string;
  sessionId?: string;
  captureId?: string;
  deviceId?: string;
  originalName: string;
  mimeType: string;
  sha256: string;
  assetPath: string;
  imageBlockId: string;
  transcriptBlockId?: string;
  recognitionJobId: string;
  recognitionStatus: RecognitionJobStatus;
  receivedAt: string;
  duplicate: boolean;
  warnings?: string[];
};

export interface PhotoIngestPort {
  acceptPhoto(input: IngestPhotoArgs): Promise<IngestPhotoResult>;
  processAcceptedRecognition(accepted: IngestPhotoResult): Promise<IngestPhotoResult>;
  getAcceptedUpload?(uploadId: string): Promise<IngestPhotoResult>;
  retryAcceptedRecognition?(uploadId: string): Promise<IngestPhotoResult>;
}

export type IngestPdfArgs = {
  notebookId: string;
  sessionId: string;
  originalName: string;
  mimeType: string;
  bytes: Buffer;
  sha256?: string;
  captureId?: string;
  deviceId?: string;
  receivedAt: string;
};

export type IngestPdfResult = {
  materialType: "pdf";
  uploadId: string;
  duplicate: boolean;
  notebookId: string;
  sessionId: string;
  sourcePath: string;
  inboxPath: string;
  fileName: string;
  byteLength: number;
  pageCount: number;
  assetPath?: string;
  pdfBlockId?: string;
  receivedAt: string;
};

export interface PdfIngestPort {
  acceptPdf(input: IngestPdfArgs): Promise<IngestPdfResult>;
}

export type PairingTarget = {
  notebookId: string;
  notebookTitle?: string;
  sessionId: string;
  title: string;
};

export type CompanionSessionAsset = { id: string; path: string; mimeType: string };

export type CompanionSessionSnapshot = {
  version: 1;
  notebookId: string;
  sessionId: string;
  title: string;
  revision: string;
  updatedAt: string;
  blockCount: number;
  markdown: string;
  html: string;
  assets: CompanionSessionAsset[];
};

export type CompanionAsset = { bytes: Buffer; mimeType: string };

export class UploadError extends Error {
  readonly name = "UploadError";
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export class CompanionAssetError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "CompanionAssetError";
  }
}
