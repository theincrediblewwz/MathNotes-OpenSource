import { canonicalJson, sha256Canonical, sha256Text } from "./canonical";
import { createEntityId } from "./ids";
import { normalizeProtectedSpans } from "./operations";
import type {
  ApplyResult,
  ConflictMaterial,
  ConflictReason,
  RejectedOutcome,
  StoredOperationOutcome,
  SyncManifest,
  SyncOperation,
  SyncReplicaState
} from "./types";

export type ApplyOperationResult = {
  state: SyncReplicaState;
  result: ApplyResult;
  conflictMaterial?: ConflictMaterial;
};

export function createReplicaState(replicaId: string, sessionId: string): SyncReplicaState {
  return {
    schemaVersion: 3,
    replicaId,
    sessionId,
    sequence: 0,
    orderRevision: 0,
    blockOrder: [],
    blocks: {},
    processedOperations: {},
    conflicts: {},
    journal: []
  };
}

export function applySyncOperation(
  currentState: SyncReplicaState,
  operation: SyncOperation,
  options: { now?: () => string; createId?: () => string } = {}
): ApplyOperationResult {
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? createEntityId;
  const operationKey = `${operation.writerId}:${operation.operationId}`;
  const fingerprint = sha256Canonical(operation);
  const processed = currentState.processedOperations[operationKey];
  if (processed) {
    if (processed.fingerprint !== fingerprint) {
      return rejectedWithoutMutation(currentState, "OPERATION_ID_REUSED");
    }
    return { state: currentState, result: { ...processed.outcome, replayed: true } };
  }

  if (operation.kind === "move_block") {
    return applyMove(currentState, operation, operationKey, fingerprint, now, createId);
  }

  if (operation.kind === "put_block" && sha256Text(operation.content) !== operation.contentHash) {
    return rememberRejected(currentState, operationKey, fingerprint, "CONTENT_HASH_MISMATCH");
  }

  const current = currentState.blocks[operation.blockId];
  if (!current && operation.kind === "delete_block") {
    return rememberRejected(currentState, operationKey, fingerprint, "MISSING_BLOCK");
  }
  if (!current && operation.kind === "put_block" && operation.baseRevision !== null) {
    return createConflict(currentState, operation, operationKey, fingerprint, "diverged_edit", now, createId);
  }
  if (current && operation.baseRevision !== current.revision) {
    const reason: ConflictReason = current.deleted || operation.kind === "delete_block"
      ? "delete_vs_edit"
      : "diverged_edit";
    return createConflict(currentState, operation, operationKey, fingerprint, reason, now, createId);
  }
  if (current?.deleted && operation.kind === "put_block") {
    return createConflict(currentState, operation, operationKey, fingerprint, "delete_vs_edit", now, createId);
  }
  if (current) {
    if (!sameProtectedSpans(current.protectedSpans, operation.protectedSpans)) {
      return rememberRejected(currentState, operationKey, fingerprint, "LOCKED_CONTENT_CHANGED");
    }
    if (current.lockStateHash !== operation.lockStateHash) {
      return createConflict(currentState, operation, operationKey, fingerprint, "lock_mismatch", now, createId);
    }
    if (operation.kind === "delete_block" && operation.contentHash !== current.contentHash) {
      return createConflict(currentState, operation, operationKey, fingerprint, "delete_vs_edit", now, createId);
    }
  }

  const next = structuredClone(currentState);
  const revision = (current?.revision ?? 0) + 1;
  const sequence = currentState.sequence + 1;
  const content = operation.kind === "put_block" ? operation.content : current?.content ?? "";
  const contentHash = operation.kind === "put_block" ? operation.contentHash : current?.contentHash ?? sha256Text("");
  next.sequence = sequence;
  next.blocks[operation.blockId] = {
    blockId: operation.blockId,
    revision,
    baseRevision: operation.baseRevision,
    writerId: operation.writerId,
    operationId: operation.operationId,
    content,
    contentHash,
    lockStateHash: operation.lockStateHash,
    protectedSpans: normalizeProtectedSpans(operation.protectedSpans),
    updatedAt: now(),
    deleted: operation.kind === "delete_block"
  };
  if (!current) {
    next.blockOrder.push(operation.blockId);
    next.orderRevision += 1;
  }
  const outcome: StoredOperationOutcome = { status: "accepted", revision, sequence };
  next.processedOperations[operationKey] = { fingerprint, outcome };
  next.journal.push({ sequence, operation: structuredClone(operation) });
  return { state: next, result: { ...outcome, replayed: false } };
}

export function createManifest(state: SyncReplicaState): SyncManifest {
  const blocks = Object.values(state.blocks)
    .map(({ blockId, revision, contentHash, lockStateHash, deleted }) => ({
      blockId,
      revision,
      contentHash,
      lockStateHash,
      deleted
    }))
    .sort((left, right) => left.blockId.localeCompare(right.blockId));
  const hashInput = {
    schemaVersion: state.schemaVersion,
    sessionId: state.sessionId,
    orderRevision: state.orderRevision,
    blockOrder: state.blockOrder,
    blocks
  };
  return {
    schemaVersion: 3,
    replicaId: state.replicaId,
    sessionId: state.sessionId,
    sequence: state.sequence,
    orderRevision: state.orderRevision,
    blockOrder: [...state.blockOrder],
    blocks,
    unresolvedConflicts: Object.values(state.conflicts).filter((conflict) => conflict.status === "unresolved").length,
    tombstones: blocks.filter((block) => block.deleted).length,
    stateHash: sha256Canonical(hashInput)
  };
}

function applyMove(
  currentState: SyncReplicaState,
  operation: Extract<SyncOperation, { kind: "move_block" }>,
  operationKey: string,
  fingerprint: string,
  now: () => string,
  createId: () => string
): ApplyOperationResult {
  if (!currentState.blocks[operation.blockId]) {
    return rememberRejected(currentState, operationKey, fingerprint, "MISSING_BLOCK");
  }
  if (operation.afterBlockId !== null && !currentState.blocks[operation.afterBlockId]) {
    return rememberRejected(currentState, operationKey, fingerprint, "MISSING_BLOCK");
  }
  if (operation.baseOrderRevision !== currentState.orderRevision) {
    return createConflict(currentState, operation, operationKey, fingerprint, "order_conflict", now, createId);
  }
  const next = structuredClone(currentState);
  const order = next.blockOrder.filter((blockId) => blockId !== operation.blockId);
  const insertionIndex = operation.afterBlockId === null ? 0 : order.indexOf(operation.afterBlockId) + 1;
  order.splice(insertionIndex, 0, operation.blockId);
  next.blockOrder = order;
  next.orderRevision += 1;
  next.sequence += 1;
  const outcome: StoredOperationOutcome = {
    status: "accepted",
    revision: next.orderRevision,
    sequence: next.sequence
  };
  next.processedOperations[operationKey] = { fingerprint, outcome };
  next.journal.push({ sequence: next.sequence, operation: structuredClone(operation) });
  return { state: next, result: { ...outcome, replayed: false } };
}

function createConflict(
  currentState: SyncReplicaState,
  operation: SyncOperation,
  operationKey: string,
  fingerprint: string,
  reason: ConflictReason,
  now: () => string,
  createId: () => string
): ApplyOperationResult {
  const next = structuredClone(currentState);
  const conflictId = createId();
  const sequence = currentState.sequence + 1;
  const current = currentState.blocks[operation.blockId];
  const currentContent = operation.kind === "move_block"
    ? canonicalJson(currentState.blockOrder)
    : current?.content ?? "";
  const incomingContent = operation.kind === "put_block"
    ? operation.content
    : operation.kind === "delete_block"
      ? "[deleted]"
      : canonicalJson({ blockId: operation.blockId, afterBlockId: operation.afterBlockId });
  const record = {
    id: conflictId,
    entityId: operation.kind === "move_block" ? currentState.sessionId : operation.blockId,
    baseRevision: operation.kind === "move_block" ? operation.baseOrderRevision : operation.baseRevision,
    currentRevision: operation.kind === "move_block" ? currentState.orderRevision : current?.revision ?? 0,
    incomingWriterId: operation.writerId,
    currentContentPath: `conflicts/${conflictId}/current.md`,
    incomingContentPath: `conflicts/${conflictId}/incoming.md`,
    reason,
    status: "unresolved" as const,
    createdAt: now()
  };
  next.sequence = sequence;
  next.conflicts[conflictId] = record;
  const outcome: StoredOperationOutcome = { status: "conflict", conflictId, reason, sequence };
  next.processedOperations[operationKey] = { fingerprint, outcome };
  return {
    state: next,
    result: { ...outcome, replayed: false },
    conflictMaterial: { record, currentContent, incomingContent }
  };
}

function rememberRejected(
  currentState: SyncReplicaState,
  operationKey: string,
  fingerprint: string,
  code: RejectedOutcome["code"]
): ApplyOperationResult {
  const next = structuredClone(currentState);
  const outcome: RejectedOutcome = { status: "rejected", code, sequence: currentState.sequence };
  next.processedOperations[operationKey] = { fingerprint, outcome };
  return { state: next, result: { ...outcome, replayed: false } };
}

function rejectedWithoutMutation(currentState: SyncReplicaState, code: RejectedOutcome["code"]): ApplyOperationResult {
  return {
    state: currentState,
    result: { status: "rejected", code, sequence: currentState.sequence, replayed: false }
  };
}

function sameProtectedSpans(
  left: Array<{ id: string; contentHash: string }>,
  right: Array<{ id: string; contentHash: string }>
): boolean {
  return canonicalJson(normalizeProtectedSpans(left)) === canonicalJson(normalizeProtectedSpans(right));
}
