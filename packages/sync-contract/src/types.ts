export type ProtectedSpanDigest = {
  id: string;
  contentHash: string;
};

export type SyncActor = "user" | "ai" | "mcp" | "sync";

export type PutBlockOperation = {
  kind: "put_block";
  blockId: string;
  baseRevision: number | null;
  writerId: string;
  operationId: string;
  actor: SyncActor;
  content: string;
  contentHash: string;
  lockStateHash: string;
  protectedSpans: ProtectedSpanDigest[];
};

export type DeleteBlockOperation = {
  kind: "delete_block";
  blockId: string;
  baseRevision: number;
  writerId: string;
  operationId: string;
  actor: SyncActor;
  contentHash: string;
  lockStateHash: string;
  protectedSpans: ProtectedSpanDigest[];
};

export type MoveBlockOperation = {
  kind: "move_block";
  blockId: string;
  afterBlockId: string | null;
  baseOrderRevision: number;
  writerId: string;
  operationId: string;
  actor: SyncActor;
};

export type SyncOperation = PutBlockOperation | DeleteBlockOperation | MoveBlockOperation;

export type BlockVersion = {
  blockId: string;
  revision: number;
  baseRevision: number | null;
  writerId: string;
  operationId: string;
  content: string;
  contentHash: string;
  lockStateHash: string;
  protectedSpans: ProtectedSpanDigest[];
  updatedAt: string;
  deleted: boolean;
};

export type ConflictReason = "diverged_edit" | "delete_vs_edit" | "lock_mismatch" | "order_conflict";

export type ConflictRecord = {
  id: string;
  entityId: string;
  baseRevision: number | null;
  currentRevision: number;
  incomingWriterId: string;
  currentContentPath: string;
  incomingContentPath: string;
  reason: ConflictReason;
  status: "unresolved" | "resolved_current" | "resolved_incoming" | "resolved_merged";
  createdAt: string;
};

export type AcceptedOutcome = {
  status: "accepted";
  revision: number;
  sequence: number;
};

export type ConflictOutcome = {
  status: "conflict";
  conflictId: string;
  reason: ConflictReason;
  sequence: number;
};

export type RejectedOutcome = {
  status: "rejected";
  code: "CONTENT_HASH_MISMATCH" | "LOCKED_CONTENT_CHANGED" | "MISSING_BLOCK" | "OPERATION_ID_REUSED";
  sequence: number;
};

export type StoredOperationOutcome = AcceptedOutcome | ConflictOutcome | RejectedOutcome;
export type ApplyResult = StoredOperationOutcome & { replayed: boolean };

export type ProcessedOperation = {
  fingerprint: string;
  outcome: StoredOperationOutcome;
};

export type JournalEntry = {
  sequence: number;
  operation: SyncOperation;
};

export type SyncReplicaState = {
  schemaVersion: 3;
  replicaId: string;
  sessionId: string;
  sequence: number;
  orderRevision: number;
  blockOrder: string[];
  blocks: Record<string, BlockVersion>;
  processedOperations: Record<string, ProcessedOperation>;
  conflicts: Record<string, ConflictRecord>;
  journal: JournalEntry[];
};

export type SyncManifest = {
  schemaVersion: 3;
  replicaId: string;
  sessionId: string;
  sequence: number;
  orderRevision: number;
  blockOrder: string[];
  blocks: Array<Pick<BlockVersion, "blockId" | "revision" | "contentHash" | "lockStateHash" | "deleted">>;
  unresolvedConflicts: number;
  tombstones: number;
  stateHash: string;
};

export type ConflictMaterial = {
  record: ConflictRecord;
  currentContent: string;
  incomingContent: string;
};
