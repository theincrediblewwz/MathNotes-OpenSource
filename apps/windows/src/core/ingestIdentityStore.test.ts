import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readIngestIdentity, writeIngestIdentity } from "./ingestIdentityStore";

describe("ingestIdentityStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-ingest-identity-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("persists the token and the actual listening port", async () => {
    const identity = { version: 1 as const, token: "a".repeat(64), port: 45_671 };
    await writeIngestIdentity(rootDir, identity);
    await expect(readIngestIdentity(rootDir)).resolves.toEqual(identity);
  });

  it("rejects missing, malformed and unsafe identities", async () => {
    await expect(readIngestIdentity(rootDir)).resolves.toBeNull();
    await writeFile(join(rootDir, "ingest-identity.json"), '{"version":1,"token":"short","port":0}\n', "utf8");
    await expect(readIngestIdentity(rootDir)).resolves.toBeNull();
  });

  it("accepts a user-defined token compatible with Android manual pairing", async () => {
    const identity = { version: 1 as const, token: "MathNotes-Remote_2026", port: 30_078 };
    await writeIngestIdentity(rootDir, identity);
    await expect(readIngestIdentity(rootDir)).resolves.toEqual(identity);
  });

  it("keeps a safe preferred host while remaining compatible with old version 1 files", async () => {
    const identity = {
      version: 1 as const,
      token: "MathNotes-Remote_2026",
      port: 30_078,
      preferredHost: "192.168.42.129"
    };
    await writeIngestIdentity(rootDir, identity);
    await expect(readIngestIdentity(rootDir)).resolves.toEqual(identity);

    await writeFile(
      join(rootDir, "ingest-identity.json"),
      `${JSON.stringify({ version: 1, token: identity.token, port: identity.port })}\n`,
      "utf8"
    );
    await expect(readIngestIdentity(rootDir)).resolves.toEqual({
      version: 1,
      token: identity.token,
      port: identity.port
    });
  });

  it("ignores an unsafe preferred host without losing the token and port", async () => {
    const stored = {
      version: 1,
      token: "MathNotes-Remote_2026",
      port: 30_078,
      preferredHost: "8.8.8.8"
    };
    await writeFile(join(rootDir, "ingest-identity.json"), `${JSON.stringify(stored)}\n`, "utf8");

    await expect(readIngestIdentity(rootDir)).resolves.toEqual({
      version: 1,
      token: stored.token,
      port: stored.port
    });
  });

  it("refuses to persist an unsafe fixed host", async () => {
    await expect(writeIngestIdentity(rootDir, {
      version: 1,
      token: "MathNotes-Remote_2026",
      port: 30_078,
      preferredHost: "8.8.8.8"
    })).rejects.toThrow("Invalid ingest identity");
  });
});
