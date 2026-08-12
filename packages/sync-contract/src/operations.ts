import { createEntityId } from "./ids";
import { sha256Text } from "./canonical";
import type {
  DeleteBlockOperation,
  MoveBlockOperation,
  ProtectedSpanDigest,
  PutBlockOperation,
  SyncActor
} from "./types";

type CommonOperationInput = {
  blockId: string;
  writerId: string;
  operationId?: string;
  actor?: SyncActor;
};

export function createPutBlockOperation(input: CommonOperationInput & {
  baseRevision: number | null;
  content: string;
  lockStateHash?: string;
  protectedSpans?: ProtectedSpanDigest[];
}): PutBlockOperation {
  return {
    kind: "put_block",
    blockId: input.blockId,
    baseRevision: input.baseRevision,
    writerId: input.writerId,
    operationId: input.operationId ?? createEntityId(),
    actor: input.actor ?? "user",
    content: input.content,
    contentHash: sha256Text(input.content),
    lockStateHash: input.lockStateHash ?? sha256Text("unlocked"),
    protectedSpans: normalizeProtectedSpans(input.protectedSpans ?? [])
  };
}

export function createDeleteBlockOperation(input: CommonOperationInput & {
  baseRevision: number;
  currentContent: string;
  lockStateHash?: string;
  protectedSpans?: ProtectedSpanDigest[];
}): DeleteBlockOperation {
  return {
    kind: "delete_block",
    blockId: input.blockId,
    baseRevision: input.baseRevision,
    writerId: input.writerId,
    operationId: input.operationId ?? createEntityId(),
    actor: input.actor ?? "user",
    contentHash: sha256Text(input.currentContent),
    lockStateHash: input.lockStateHash ?? sha256Text("unlocked"),
    protectedSpans: normalizeProtectedSpans(input.protectedSpans ?? [])
  };
}

export function createMoveBlockOperation(input: CommonOperationInput & {
  afterBlockId: string | null;
  baseOrderRevision: number;
}): MoveBlockOperation {
  return {
    kind: "move_block",
    blockId: input.blockId,
    afterBlockId: input.afterBlockId,
    baseOrderRevision: input.baseOrderRevision,
    writerId: input.writerId,
    operationId: input.operationId ?? createEntityId(),
    actor: input.actor ?? "user"
  };
}

export function normalizeProtectedSpans(spans: ProtectedSpanDigest[]): ProtectedSpanDigest[] {
  return spans.map((span) => ({ ...span })).sort((left, right) => left.id.localeCompare(right.id));
}
