import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export type AssetUploadRecord = {
  id: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  originalName?: string;
  state: "uploading" | "available" | "quarantined";
  receivedBytes: number;
  outputPath?: string;
};

type AssetStoreState = {
  schemaVersion: 1;
  assets: Record<string, AssetUploadRecord>;
};

export class FileAssetStore {
  private constructor(private readonly rootDir: string, private state: AssetStoreState) {}

  static async open(rootDir: string): Promise<FileAssetStore> {
    await mkdir(rootDir, { recursive: true });
    const target = join(rootDir, "asset-manifest.json");
    let state: AssetStoreState;
    try {
      state = JSON.parse(await readFile(target, "utf8")) as AssetStoreState;
      if (state.schemaVersion !== 1) throw new Error("ASSET_MANIFEST_SCHEMA_UNSUPPORTED");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      state = { schemaVersion: 1, assets: {} };
      await writeJsonAtomic(target, state);
    }
    return new FileAssetStore(rootDir, state);
  }

  async begin(input: Omit<AssetUploadRecord, "state" | "receivedBytes" | "outputPath">): Promise<AssetUploadRecord> {
    validateAssetInput(input.id, input.sha256, input.byteLength);
    const existing = this.state.assets[input.id];
    if (existing) {
      if (existing.sha256 !== input.sha256 || existing.byteLength !== input.byteLength || existing.mediaType !== input.mediaType) {
        throw new Error("ASSET_ID_REUSED");
      }
      if (existing.state === "uploading") {
        existing.receivedBytes = await fileSizeOrZero(this.partPath(input.id));
        await this.persist();
      }
      return structuredClone(existing);
    }
    const record: AssetUploadRecord = { ...input, state: "uploading", receivedBytes: 0 };
    this.state.assets[input.id] = record;
    await this.persist();
    return structuredClone(record);
  }

  async append(assetId: string, expectedOffset: number, bytes: Uint8Array): Promise<AssetUploadRecord> {
    const record = this.requireAsset(assetId);
    if (record.state !== "uploading") throw new Error("ASSET_NOT_UPLOADING");
    const target = this.partPath(assetId);
    await mkdir(dirname(target), { recursive: true });
    const currentSize = await fileSizeOrZero(target);
    if (currentSize !== expectedOffset) throw new Error(`ASSET_OFFSET_MISMATCH:${currentSize}`);
    if (currentSize + bytes.byteLength > record.byteLength) throw new Error("ASSET_LENGTH_EXCEEDED");
    const handle = await open(target, "a");
    try {
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    record.receivedBytes = currentSize + bytes.byteLength;
    await this.persist();
    return structuredClone(record);
  }

  async finalize(assetId: string): Promise<AssetUploadRecord> {
    const record = this.requireAsset(assetId);
    if (record.state === "available") return structuredClone(record);
    if (record.state !== "uploading") throw new Error("ASSET_QUARANTINED");
    const source = this.partPath(assetId);
    const sourceSize = (await stat(source)).size;
    if (sourceSize !== record.byteLength) throw new Error(`ASSET_INCOMPLETE:${sourceSize}`);
    const digest = await hashFile(source);
    if (digest !== record.sha256) {
      const quarantinePath = join(this.rootDir, "quarantined", `${assetId}.bin`);
      await mkdir(dirname(quarantinePath), { recursive: true });
      await rename(source, quarantinePath);
      record.state = "quarantined";
      record.outputPath = portableRelative(this.rootDir, quarantinePath);
      await this.persist();
      throw new Error("ASSET_HASH_MISMATCH");
    }
    const target = join(this.rootDir, "available", digest);
    await mkdir(dirname(target), { recursive: true });
    try {
      await access(target);
      await rm(source, { force: true });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await rename(source, target);
    }
    record.state = "available";
    record.receivedBytes = record.byteLength;
    record.outputPath = portableRelative(this.rootDir, target);
    await this.persist();
    return structuredClone(record);
  }

  get(assetId: string): AssetUploadRecord | null {
    const record = this.state.assets[assetId];
    return record ? structuredClone(record) : null;
  }

  private requireAsset(assetId: string): AssetUploadRecord {
    const record = this.state.assets[assetId];
    if (!record) throw new Error("ASSET_NOT_FOUND");
    return record;
  }

  private partPath(assetId: string): string {
    return join(this.rootDir, "uploading", `${assetId}.part`);
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(join(this.rootDir, "asset-manifest.json"), this.state);
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function fileSizeOrZero(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp-${randomUUID()}`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function validateAssetInput(id: string, sha256: string, byteLength: number): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("ASSET_ID_INVALID");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("ASSET_SHA256_INVALID");
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("ASSET_LENGTH_INVALID");
}

function portableRelative(rootDir: string, target: string): string {
  return relative(rootDir, target).replaceAll("\\", "/");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
