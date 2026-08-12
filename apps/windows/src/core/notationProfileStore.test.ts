import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createEmptyNotationProfileConfig } from "../common/notationProfiles";
import {
  notationProfileConfigPath,
  readNotationProfileConfig,
  writeNotationProfileConfig
} from "./notationProfileStore";

describe("notationProfileStore", () => {
  it("atomically writes normalized user profiles outside the faithful contract", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mathnotes-notation-"));
    const now = "2026-07-15T08:00:00.000Z";
    const saved = await writeNotationProfileConfig({
      rootDir,
      config: {
        schemaVersion: "nh1-v1",
        revision: 2,
        profiles: [
          {
            id: "functional analysis !",
            name: "泛函分析",
            description: " 课堂记号 ",
            enabled: true,
            status: "active",
            priority: 3,
            version: 2,
            createdAt: now,
            updatedAt: now,
            rules: [
              {
                id: "stable space",
                kind: "symbol",
                pattern: " X_+ ",
                meaning: " 稳定子空间 ",
                aliases: ["X^+", "X^+"],
                keywords: ["稳定"],
                enabled: true,
                status: "approved",
                version: 2,
                source: { type: "user" },
                createdAt: now,
                updatedAt: now,
                approvedAt: now
              }
            ]
          }
        ]
      }
    });

    expect(saved.profiles[0].id).toBe("functional_analysis__");
    expect(saved.profiles[0].rules[0].id).toBe("stable_space");
    expect(saved.profiles[0].rules[0].aliases).toEqual(["X^+"]);
    expect(JSON.parse(await readFile(notationProfileConfigPath(rootDir), "utf8"))).toEqual(saved);
  });

  it("recovers from malformed primary configuration using the last valid backup", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mathnotes-notation-recovery-"));
    const target = notationProfileConfigPath(rootDir);
    await mkdir(join(rootDir, "settings", "notation"), { recursive: true });
    const fallback = { ...createEmptyNotationProfileConfig(), revision: 7 };
    await writeFile(`${target}.bak`, JSON.stringify(fallback), "utf8");
    await writeFile(target, "{broken", "utf8");

    await expect(readNotationProfileConfig({ rootDir })).resolves.toEqual(fallback);
  });

  it("falls back to an empty safe configuration when no valid file exists", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mathnotes-notation-empty-"));

    await expect(readNotationProfileConfig({ rootDir })).resolves.toEqual(createEmptyNotationProfileConfig());
  });
});
