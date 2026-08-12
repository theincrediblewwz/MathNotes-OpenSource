import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  coordinatorRebuildFixtureMarker,
  createDeleteBlockOperation,
  createMoveBlockOperation,
  createPutBlockOperation,
  FileAssetStore,
  FileSyncReplica,
  rebuildCoordinatorIndex,
  sha256Text
} from "./index";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("coordinator index rebuild", () => {
  it("rebuilds the same non-destructive index after complete coordinator loss", async () => {
    const fixture = await createFixture();
    const first = await rebuildCoordinatorIndex({ ...fixture, allowFixtureWrite: true });

    expect(first.index.blocks.find((block) => block.blockId === "shared")?.requiresResolution).toBe(true);
    expect(first.index.blocks.find((block) => block.blockId === "removed")?.variants.some((variant) => variant.deleted)).toBe(true);
    expect(first.index.orderVariants).toHaveLength(2);
    expect(first.index.conflicts.length).toBeGreaterThan(0);
    expect(first.index.assets).toHaveLength(1);
    expect(first.index.assets[0].variants[0].storedSha256).toBe(first.index.assets[0].variants[0].expectedSha256);

    await rm(fixture.coordinatorDir, { recursive: true, force: true });
    const second = await rebuildCoordinatorIndex({
      ...fixture,
      nodes: [...fixture.nodes].reverse(),
      allowFixtureWrite: true
    });
    expect(second.index).toEqual(first.index);
    expect(JSON.parse(await readFile(second.targetPath, "utf8"))).toEqual(first.index);
  });

  it("keeps divergent leaf versions instead of selecting a hidden winner", async () => {
    const fixture = await createFixture();
    const { index } = await rebuildCoordinatorIndex({ ...fixture, allowFixtureWrite: true });
    const shared = index.blocks.find((block) => block.blockId === "shared");

    expect(shared?.variants).toHaveLength(2);
    expect(shared?.requiresResolution).toBe(true);
    expect(new Set(shared?.variants.map((variant) => variant.contentHash)).size).toBe(2);
  });

  it("rejects missing conflict evidence and corrupted available assets", async () => {
    const fixture = await createFixture();
    const leftState = JSON.parse(await readFile(join(fixture.nodes[0].replicaRootDir, "sync-state.json"), "utf8")) as {
      conflicts: Record<string, { incomingContentPath: string }>;
    };
    const conflict = Object.values(leftState.conflicts)[0];
    await rm(join(fixture.nodes[0].replicaRootDir, conflict.incomingContentPath), { force: true });
    await expect(rebuildCoordinatorIndex({ ...fixture, allowFixtureWrite: true })).rejects.toMatchObject({ code: "ENOENT" });

    const fresh = await createFixture();
    const manifest = JSON.parse(await readFile(join(fresh.nodes[0].assetRootDir!, "asset-manifest.json"), "utf8")) as {
      assets: Record<string, { outputPath: string }>;
    };
    await writeFile(join(fresh.nodes[0].assetRootDir!, manifest.assets.diagram.outputPath), "corrupt");
    await expect(rebuildCoordinatorIndex({ ...fresh, allowFixtureWrite: true }))
      .rejects.toThrow("COORDINATOR_ASSET_LENGTH_MISMATCH");
  });

  it("requires an explicit fixture marker and two distinct replicas", async () => {
    const fixture = await createFixture();
    await rm(join(fixture.fixtureRootDir, coordinatorRebuildFixtureMarker));
    await expect(rebuildCoordinatorIndex({ ...fixture, allowFixtureWrite: true }))
      .rejects.toThrow("COORDINATOR_REBUILD_FIXTURE_MARKER_REQUIRED");

    const single = await createFixture();
    await expect(rebuildCoordinatorIndex({ ...single, nodes: [single.nodes[0]], allowFixtureWrite: true }))
      .rejects.toThrow("COORDINATOR_REBUILD_REQUIRES_TWO_NODES");
  });
});

async function createFixture(): Promise<{
  fixtureRootDir: string;
  coordinatorDir: string;
  nodes: Array<{ nodeId: string; replicaRootDir: string; assetRootDir: string }>;
}> {
  const fixtureRootDir = await mkdtemp(join(tmpdir(), "mathnotes-coordinator-rebuild-"));
  temporaryRoots.push(fixtureRootDir);
  await writeFile(join(fixtureRootDir, coordinatorRebuildFixtureMarker), "fixture only\n", "utf8");
  const leftRoot = join(fixtureRootDir, "nodes", "left", "replica");
  const rightRoot = join(fixtureRootDir, "nodes", "right", "replica");
  const leftAssets = join(fixtureRootDir, "nodes", "left", "assets");
  const rightAssets = join(fixtureRootDir, "nodes", "right", "assets");
  await mkdir(leftRoot, { recursive: true });
  await mkdir(rightRoot, { recursive: true });
  const left = await FileSyncReplica.open(leftRoot, "left-replica", "session-one");
  const right = await FileSyncReplica.open(rightRoot, "right-replica", "session-one");

  await left.apply(createPutBlockOperation({ blockId: "shared", baseRevision: null, writerId: "seed", content: "base" }));
  await left.apply(createPutBlockOperation({ blockId: "removed", baseRevision: null, writerId: "seed", content: "remove me" }));
  await right.reconcileFrom(left);
  await left.apply(createPutBlockOperation({ blockId: "shared", baseRevision: 1, writerId: "left", content: "left leaf" }));
  await right.apply(createPutBlockOperation({ blockId: "shared", baseRevision: 1, writerId: "right", content: "right leaf" }));
  await left.apply(createDeleteBlockOperation({ blockId: "removed", baseRevision: 1, writerId: "left", currentContent: "remove me" }));
  await right.apply(createMoveBlockOperation({
    blockId: "removed",
    afterBlockId: null,
    baseOrderRevision: right.getState().orderRevision,
    writerId: "right"
  }));
  await left.reconcileFrom(right);
  await right.reconcileFrom(left);
  await left.apply(createMoveBlockOperation({
    blockId: "shared",
    afterBlockId: null,
    baseOrderRevision: left.getState().orderRevision,
    writerId: "left-order-fork"
  }));

  const bytes = Buffer.from("diagram-bytes");
  for (const root of [leftAssets, rightAssets]) {
    const store = await FileAssetStore.open(root);
    await store.begin({
      id: "diagram",
      sha256: sha256Text(bytes.toString("utf8")),
      byteLength: bytes.length,
      mediaType: "image/png"
    });
    await store.append("diagram", 0, bytes);
    await store.finalize("diagram");
  }

  return {
    fixtureRootDir,
    coordinatorDir: join(fixtureRootDir, "coordinator"),
    nodes: [
      { nodeId: "left-node", replicaRootDir: leftRoot, assetRootDir: leftAssets },
      { nodeId: "right-node", replicaRootDir: rightRoot, assetRootDir: rightAssets }
    ]
  };
}
