import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileAssetStore,
  FileSyncReplica,
  canonicalJson,
  createDeleteBlockOperation,
  createEntityId,
  createMoveBlockOperation,
  createPutBlockOperation,
  isUuidV7,
  sha256Text
} from "./index";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Sync Contract v3 primitives", () => {
  it("uses UUIDv7 and deterministic canonical JSON", () => {
    const id = createEntityId();
    expect(isUuidV7(id)).toBe(true);
    expect(canonicalJson({ z: 1, a: [true, { y: "二", x: "一" }] }))
      .toBe('{"a":[true,{"x":"一","y":"二"}],"z":1}');
  });
});

describe("FileSyncReplica dual-instance matrix", () => {
  it("merges edits to different blocks and recovers a missed event by journal reconciliation", async () => {
    const { left, right } = await openPair();
    await seed(left, right, "b1", "one");
    await seed(left, right, "b2", "two");

    await left.apply(createPutBlockOperation({ blockId: "b1", baseRevision: 1, writerId: "left", content: "one-left" }));
    await right.apply(createPutBlockOperation({ blockId: "b2", baseRevision: 1, writerId: "right", content: "two-right" }));
    expect(left.getManifest().stateHash).not.toBe(right.getManifest().stateHash);

    await left.reconcileFrom(right);
    await right.reconcileFrom(left);

    expect(left.getState().blocks.b1.content).toBe("one-left");
    expect(left.getState().blocks.b2.content).toBe("two-right");
    expect(right.getManifest().stateHash).toBe(left.getManifest().stateHash);
  });

  it("preserves both sides of a divergent edit in conflict sidecars", async () => {
    const { left, right, leftDir } = await openPair();
    await seed(left, right, "same", "base");
    await left.apply(createPutBlockOperation({ blockId: "same", baseRevision: 1, writerId: "left", content: "left edit" }));
    await right.apply(createPutBlockOperation({ blockId: "same", baseRevision: 1, writerId: "right", content: "right edit" }));

    const summary = await left.reconcileFrom(right);
    expect(summary.conflicts).toBe(1);
    expect(left.getState().blocks.same.content).toBe("left edit");
    const conflict = Object.values(left.getState().conflicts)[0];
    expect(conflict?.reason).toBe("diverged_edit");
    expect(await readFile(join(leftDir, conflict!.currentContentPath), "utf8")).toBe("left edit");
    expect(await readFile(join(leftDir, conflict!.incomingContentPath), "utf8")).toBe("right edit");
  });

  it("keeps a tombstone when a remote replica edits the deleted baseline", async () => {
    const { left, right } = await openPair();
    await seed(left, right, "gone", "base");
    await left.apply(createDeleteBlockOperation({
      blockId: "gone",
      baseRevision: 1,
      writerId: "left",
      currentContent: "base"
    }));
    await right.apply(createPutBlockOperation({ blockId: "gone", baseRevision: 1, writerId: "right", content: "offline edit" }));

    const summary = await left.reconcileFrom(right);
    expect(summary.conflicts).toBe(1);
    expect(left.getState().blocks.gone.deleted).toBe(true);
    expect(Object.values(left.getState().conflicts)[0]?.reason).toBe("delete_vs_edit");
  });

  it("applies an operation once across retries and rejects operation ID payload reuse", async () => {
    const { left, leftDir } = await openPair();
    const operation = createPutBlockOperation({
      blockId: "idem",
      baseRevision: null,
      writerId: "left",
      operationId: createEntityId(),
      content: "once"
    });
    const first = await left.apply(operation);
    const second = await left.apply(operation);
    const third = await left.apply(operation);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(third.replayed).toBe(true);
    expect(left.getState().sequence).toBe(1);
    expect(left.getState().blocks.idem.revision).toBe(1);

    const reused = { ...operation, content: "changed", contentHash: sha256Text("changed") };
    expect(await left.apply(reused)).toMatchObject({ status: "rejected", code: "OPERATION_ID_REUSED" });

    const reopened = await FileSyncReplica.open(leftDir, "left", "session");
    expect(await reopened.apply(operation)).toMatchObject({ status: "accepted", replayed: true, revision: 1 });
  });

  it("rejects protected-span mutation without changing the source block", async () => {
    const { left } = await openPair();
    const lockStateHash = sha256Text("lock-state");
    const protectedSpans = [{ id: "lock-1", contentHash: sha256Text("confirmed") }];
    await left.apply(createPutBlockOperation({
      blockId: "locked",
      baseRevision: null,
      writerId: "user",
      content: "confirmed",
      lockStateHash,
      protectedSpans
    }));
    const rejected = await left.apply(createPutBlockOperation({
      blockId: "locked",
      baseRevision: 1,
      writerId: "ai",
      actor: "ai",
      content: "rewritten",
      lockStateHash,
      protectedSpans: [{ id: "lock-1", contentHash: sha256Text("rewritten") }]
    }));
    expect(rejected).toMatchObject({ status: "rejected", code: "LOCKED_CONTENT_CHANGED" });
    expect(left.getState().blocks.locked).toMatchObject({ revision: 1, content: "confirmed" });
  });

  it("records stale order moves as an explicit order conflict", async () => {
    const { left, right } = await openPair();
    await seed(left, right, "a", "A");
    await seed(left, right, "b", "B");
    expect(left.getState().orderRevision).toBe(2);
    await left.apply(createMoveBlockOperation({
      blockId: "b",
      afterBlockId: null,
      baseOrderRevision: 2,
      writerId: "left"
    }));
    await right.apply(createMoveBlockOperation({
      blockId: "a",
      afterBlockId: "b",
      baseOrderRevision: 2,
      writerId: "right"
    }));
    await left.reconcileFrom(right);
    expect(Object.values(left.getState().conflicts).some((conflict) => conflict.reason === "order_conflict")).toBe(true);
  });
});

describe("FileAssetStore", () => {
  it("resumes from an exact offset, verifies the full hash and deduplicates the available object", async () => {
    const root = await createTempDir("assets");
    const bytes = Buffer.from("mathnotes-asset-payload");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let store = await FileAssetStore.open(root);
    await store.begin({ id: "asset-one", sha256, byteLength: bytes.length, mediaType: "image/png" });
    await store.append("asset-one", 0, bytes.subarray(0, 8));

    store = await FileAssetStore.open(root);
    expect(await store.begin({ id: "asset-one", sha256, byteLength: bytes.length, mediaType: "image/png" }))
      .toMatchObject({ state: "uploading", receivedBytes: 8 });
    await store.append("asset-one", 8, bytes.subarray(8));
    const available = await store.finalize("asset-one");
    expect(available).toMatchObject({ state: "available", receivedBytes: bytes.length });
    expect(await store.finalize("asset-one")).toEqual(available);

    await store.begin({ id: "asset-two", sha256, byteLength: bytes.length, mediaType: "image/png" });
    await store.append("asset-two", 0, bytes);
    expect((await store.finalize("asset-two")).outputPath).toBe(available.outputPath);
    expect((await readdir(join(root, "available"))).length).toBe(1);
  });

  it("quarantines a complete payload whose hash does not match", async () => {
    const root = await createTempDir("asset-quarantine");
    const bytes = Buffer.from("wrong");
    const store = await FileAssetStore.open(root);
    await store.begin({ id: "bad", sha256: sha256Text("expected"), byteLength: bytes.length, mediaType: "image/png" });
    await store.append("bad", 0, bytes);
    await expect(store.finalize("bad")).rejects.toThrow("ASSET_HASH_MISMATCH");
    expect(store.get("bad")?.state).toBe("quarantined");
  });
});

async function openPair(): Promise<{
  left: FileSyncReplica;
  right: FileSyncReplica;
  leftDir: string;
}> {
  const root = await createTempDir("replicas");
  const leftDir = join(root, "left");
  return {
    left: await FileSyncReplica.open(leftDir, "left", "session"),
    right: await FileSyncReplica.open(join(root, "right"), "right", "session"),
    leftDir
  };
}

async function seed(left: FileSyncReplica, right: FileSyncReplica, blockId: string, content: string): Promise<void> {
  await left.apply(createPutBlockOperation({ blockId, baseRevision: null, writerId: "seed", content }));
  await right.reconcileFrom(left);
}

async function createTempDir(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `mathnotes-sync-${label}-`));
  temporaryRoots.push(root);
  return root;
}
