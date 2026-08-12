import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Canonical, sha256Text } from "./canonical";
import { createManifest } from "./engine";
import type { ConflictRecord, ProtectedSpanDigest, SyncReplicaState } from "./types";

export const coordinatorRebuildFixtureMarker = ".mathnotes-coordinator-rebuild-fixture";

export type CoordinatorNodeSource = {
  nodeId: string;
  replicaRootDir: string;
  assetRootDir?: string;
};

type VariantSource = {
  nodeId: string;
  replicaId: string;
  revision: number;
  writerId: string;
  operationId: string;
};

export type CoordinatorRebuildIndex = {
  schemaVersion: 3;
  indexVersion: 1;
  sessionId: string;
  replicas: Array<{
    nodeId: string;
    replicaId: string;
    sequence: number;
    manifestHash: string;
  }>;
  blocks: Array<{
    blockId: string;
    variants: Array<{
      variantHash: string;
      contentHash: string;
      lockStateHash: string;
      deleted: boolean;
      protectedSpans: ProtectedSpanDigest[];
      sources: VariantSource[];
    }>;
    requiresResolution: boolean;
  }>;
  orderVariants: Array<{
    orderHash: string;
    blockOrder: string[];
    sources: Array<{ nodeId: string; replicaId: string; orderRevision: number }>;
  }>;
  conflicts: Array<{
    evidenceHash: string;
    entityId: string;
    baseRevision: number | null;
    currentRevision: number;
    incomingWriterId: string;
    reason: ConflictRecord["reason"];
    status: ConflictRecord["status"];
    currentContentHash: string;
    incomingContentHash: string;
    sources: Array<{ nodeId: string; replicaId: string; conflictId: string }>;
  }>;
  assets: Array<{
    assetId: string;
    variants: Array<{
      variantHash: string;
      expectedSha256: string;
      storedSha256: string | null;
      byteLength: number;
      receivedBytes: number;
      mediaType: string;
      state: "uploading" | "available" | "quarantined";
      sources: Array<{ nodeId: string; replicaId: string; relativePath: string | null }>;
    }>;
    requiresResolution: boolean;
  }>;
  unresolvedConflictCount: number;
  tombstoneVariantCount: number;
  indexHash: string;
};

type AssetManifestState = {
  schemaVersion: 1;
  assets: Record<string, {
    id: string;
    sha256: string;
    byteLength: number;
    mediaType: string;
    state: "uploading" | "available" | "quarantined";
    receivedBytes: number;
    outputPath?: string;
  }>;
};

export async function rebuildCoordinatorIndex(args: {
  fixtureRootDir: string;
  coordinatorDir: string;
  nodes: CoordinatorNodeSource[];
  allowFixtureWrite: true;
}): Promise<{ index: CoordinatorRebuildIndex; targetPath: string }> {
  const fixtureRootDir = resolve(args.fixtureRootDir);
  const coordinatorDir = safeResolveWithin(fixtureRootDir, relative(fixtureRootDir, resolve(args.coordinatorDir)));
  await assertFixtureRoot(fixtureRootDir);
  if (args.nodes.length < 2) throw new Error("COORDINATOR_REBUILD_REQUIRES_TWO_NODES");
  const nodeIds = new Set<string>();
  const replicaIds = new Set<string>();
  const states: Array<{ node: CoordinatorNodeSource; state: SyncReplicaState }> = [];

  for (const node of [...args.nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId))) {
    if (!node.nodeId || nodeIds.has(node.nodeId)) throw new Error(`COORDINATOR_NODE_ID_INVALID:${node.nodeId}`);
    nodeIds.add(node.nodeId);
    const replicaRootDir = safeResolveWithin(fixtureRootDir, relative(fixtureRootDir, resolve(node.replicaRootDir)));
    const state = JSON.parse(await readFile(join(replicaRootDir, "sync-state.json"), "utf8")) as SyncReplicaState;
    if (state.schemaVersion !== 3) throw new Error(`COORDINATOR_NODE_SCHEMA_UNSUPPORTED:${node.nodeId}`);
    if (replicaIds.has(state.replicaId)) throw new Error(`COORDINATOR_REPLICA_ID_REUSED:${state.replicaId}`);
    replicaIds.add(state.replicaId);
    states.push({ node: { ...node, replicaRootDir }, state });
  }

  const sessionIds = new Set(states.map(({ state }) => state.sessionId));
  if (sessionIds.size !== 1) throw new Error("COORDINATOR_SESSION_MISMATCH");
  const sessionId = states[0].state.sessionId;
  const blockGroups = new Map<string, Map<string, CoordinatorRebuildIndex["blocks"][number]["variants"][number]>>();
  const orderGroups = new Map<string, CoordinatorRebuildIndex["orderVariants"][number]>();
  const conflictGroups = new Map<string, CoordinatorRebuildIndex["conflicts"][number]>();
  const assetGroups = new Map<string, Map<string, CoordinatorRebuildIndex["assets"][number]["variants"][number]>>();

  for (const { node, state } of states) {
    for (const block of Object.values(state.blocks)) {
      if (sha256Text(block.content) !== block.contentHash) {
        throw new Error(`COORDINATOR_BLOCK_HASH_MISMATCH:${node.nodeId}:${block.blockId}`);
      }
      const protectedSpans = [...block.protectedSpans].sort((left, right) => left.id.localeCompare(right.id));
      const variantMaterial = {
        contentHash: block.contentHash,
        lockStateHash: block.lockStateHash,
        deleted: block.deleted,
        protectedSpans
      };
      const variantHash = sha256Canonical(variantMaterial);
      const variants = getOrCreate(blockGroups, block.blockId, () => new Map());
      const variant = getOrCreate(variants, variantHash, () => ({
        variantHash,
        ...variantMaterial,
        sources: []
      }));
      variant.sources.push({
        nodeId: node.nodeId,
        replicaId: state.replicaId,
        revision: block.revision,
        writerId: block.writerId,
        operationId: block.operationId
      });
    }

    const orderHash = sha256Canonical(state.blockOrder);
    const orderVariant = getOrCreate(orderGroups, orderHash, () => ({
      orderHash,
      blockOrder: [...state.blockOrder],
      sources: []
    }));
    orderVariant.sources.push({ nodeId: node.nodeId, replicaId: state.replicaId, orderRevision: state.orderRevision });

    for (const conflict of Object.values(state.conflicts)) {
      const currentContentHash = await hashConflictFile(node.replicaRootDir, conflict.currentContentPath);
      const incomingContentHash = await hashConflictFile(node.replicaRootDir, conflict.incomingContentPath);
      const evidenceMaterial = {
        entityId: conflict.entityId,
        baseRevision: conflict.baseRevision,
        currentRevision: conflict.currentRevision,
        incomingWriterId: conflict.incomingWriterId,
        reason: conflict.reason,
        status: conflict.status,
        currentContentHash,
        incomingContentHash
      };
      const evidenceHash = sha256Canonical(evidenceMaterial);
      const indexed = getOrCreate(conflictGroups, evidenceHash, () => ({
        evidenceHash,
        ...evidenceMaterial,
        sources: []
      }));
      indexed.sources.push({ nodeId: node.nodeId, replicaId: state.replicaId, conflictId: conflict.id });
    }

    if (node.assetRootDir) {
      const assetRootDir = safeResolveWithin(fixtureRootDir, relative(fixtureRootDir, resolve(node.assetRootDir)));
      const assetState = JSON.parse(await readFile(join(assetRootDir, "asset-manifest.json"), "utf8")) as AssetManifestState;
      if (assetState.schemaVersion !== 1) throw new Error(`COORDINATOR_ASSET_SCHEMA_UNSUPPORTED:${node.nodeId}`);
      for (const record of Object.values(assetState.assets)) {
        const file = await inspectAssetFile(assetRootDir, record);
        const variantMaterial = {
          expectedSha256: record.sha256,
          storedSha256: file.storedSha256,
          byteLength: record.byteLength,
          receivedBytes: record.receivedBytes,
          mediaType: record.mediaType,
          state: record.state
        };
        const variantHash = sha256Canonical(variantMaterial);
        const variants = getOrCreate(assetGroups, record.id, () => new Map());
        const variant = getOrCreate(variants, variantHash, () => ({
          variantHash,
          ...variantMaterial,
          sources: []
        }));
        variant.sources.push({
          nodeId: node.nodeId,
          replicaId: state.replicaId,
          relativePath: file.relativePath
        });
      }
    }
  }

  const withoutHash = {
    schemaVersion: 3 as const,
    indexVersion: 1 as const,
    sessionId,
    replicas: states.map(({ node, state }) => ({
      nodeId: node.nodeId,
      replicaId: state.replicaId,
      sequence: state.sequence,
      manifestHash: createManifest(state).stateHash
    })).sort(byNodeId),
    blocks: [...blockGroups.entries()].map(([blockId, variants]) => ({
      blockId,
      variants: [...variants.values()].map(sortVariantSources).sort(byVariantHash),
      requiresResolution: variants.size > 1
    })).sort((left, right) => left.blockId.localeCompare(right.blockId)),
    orderVariants: [...orderGroups.values()].map(sortOrderSources).sort((left, right) => left.orderHash.localeCompare(right.orderHash)),
    conflicts: [...conflictGroups.values()].map(sortConflictSources).sort((left, right) => left.evidenceHash.localeCompare(right.evidenceHash)),
    assets: [...assetGroups.entries()].map(([assetId, variants]) => ({
      assetId,
      variants: [...variants.values()].map(sortAssetSources).sort(byVariantHash),
      requiresResolution: variants.size > 1
    })).sort((left, right) => left.assetId.localeCompare(right.assetId)),
    unresolvedConflictCount: [...conflictGroups.values()].filter((conflict) => conflict.status === "unresolved").length,
    tombstoneVariantCount: [...blockGroups.values()].flatMap((variants) => [...variants.values()]).filter((variant) => variant.deleted).length
  };
  const index: CoordinatorRebuildIndex = { ...withoutHash, indexHash: sha256Canonical(withoutHash) };
  const targetPath = join(coordinatorDir, "coordinator-index.json");
  await writeJsonAtomic(targetPath, index);
  return { index, targetPath };
}

async function inspectAssetFile(
  rootDir: string,
  record: AssetManifestState["assets"][string]
): Promise<{ storedSha256: string | null; relativePath: string | null }> {
  const relativePath = record.outputPath ?? (record.state === "uploading" ? `uploading/${record.id}.part` : null);
  if (relativePath === null) {
    if (record.receivedBytes !== 0) throw new Error(`COORDINATOR_ASSET_FILE_MISSING:${record.id}`);
    return { storedSha256: null, relativePath: null };
  }
  const absolutePath = safeResolveWithin(rootDir, relativePath);
  const metadata = await stat(absolutePath);
  if (record.state === "available" && (metadata.size !== record.byteLength || record.receivedBytes !== record.byteLength)) {
    throw new Error(`COORDINATOR_ASSET_LENGTH_MISMATCH:${record.id}`);
  }
  if (record.state === "uploading" && metadata.size !== record.receivedBytes) {
    throw new Error(`COORDINATOR_ASSET_OFFSET_MISMATCH:${record.id}`);
  }
  const storedSha256 = await hashFile(absolutePath);
  if (record.state === "available" && storedSha256 !== record.sha256) {
    throw new Error(`COORDINATOR_ASSET_HASH_MISMATCH:${record.id}`);
  }
  return { storedSha256, relativePath: portablePath(relativePath) };
}

async function hashConflictFile(rootDir: string, relativePath: string): Promise<string> {
  return sha256Text(await readFile(safeResolveWithin(rootDir, relativePath), "utf8"));
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function assertFixtureRoot(rootDir: string): Promise<void> {
  try {
    if (!(await lstat(join(rootDir, coordinatorRebuildFixtureMarker))).isFile()) throw new Error("not file");
  } catch {
    throw new Error(`COORDINATOR_REBUILD_FIXTURE_MARKER_REQUIRED:${rootDir}`);
  }
}

function safeResolveWithin(rootDir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error(`COORDINATOR_PATH_OUTSIDE_FIXTURE:${relativePath}`);
  const root = resolve(rootDir);
  const target = resolve(root, relativePath);
  const relation = relative(root, target);
  if (!relation || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) return target;
  throw new Error(`COORDINATOR_PATH_OUTSIDE_FIXTURE:${relativePath}`);
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.tmp-${randomUUID()}`;
  const backup = `${targetPath}.bak-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, targetPath);
  } catch (error) {
    if (!(await exists(targetPath))) throw error;
    await rename(targetPath, backup);
    try {
      await rename(temporary, targetPath);
      await rm(backup, { force: true });
    } catch (replacementError) {
      await rm(targetPath, { force: true });
      await rename(backup, targetPath);
      throw replacementError;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const value = create();
  map.set(key, value);
  return value;
}

function sortVariantSources<T extends { sources: VariantSource[] }>(value: T): T {
  value.sources.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  return value;
}

function sortOrderSources<T extends { sources: Array<{ nodeId: string }> }>(value: T): T {
  value.sources.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  return value;
}

function sortConflictSources<T extends { sources: Array<{ nodeId: string; conflictId: string }> }>(value: T): T {
  value.sources.sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.conflictId.localeCompare(right.conflictId));
  return value;
}

function sortAssetSources<T extends { sources: Array<{ nodeId: string }> }>(value: T): T {
  value.sources.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  return value;
}

function byVariantHash(left: { variantHash: string }, right: { variantHash: string }): number {
  return left.variantHash.localeCompare(right.variantHash);
}

function byNodeId(left: { nodeId: string }, right: { nodeId: string }): number {
  return left.nodeId.localeCompare(right.nodeId);
}

function portablePath(value: string): string {
  return value.replaceAll("\\", "/");
}
