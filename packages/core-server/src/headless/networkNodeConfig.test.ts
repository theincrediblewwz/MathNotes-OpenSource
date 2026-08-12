import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNetworkNodeConfig } from "./networkNodeConfig";

describe("network node config", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("defaults to loopback and stores only the token environment name", async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-network-config-"));
    const path = join(root, "node.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      port: 0,
      userDataDir: join(root, "runtime"),
      notesRootDir: join(root, "notes"),
      legacyTokenEnv: "MATHNOTES_HEADLESS_TOKEN"
    }));
    await expect(readNetworkNodeConfig(path)).resolves.toMatchObject({
      host: "127.0.0.1",
      legacyTokenEnv: "MATHNOTES_HEADLESS_TOKEN",
      exposureMode: "loopback"
    });
  });

  it("defaults v2 to a loopback listener behind Tailscale Serve", async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-network-config-"));
    const path = join(root, "node.json");
    await writeFile(path, JSON.stringify({
      version: 2,
      port: 1051,
      userDataDir: join(root, "runtime"),
      notesRootDir: join(root, "notes"),
      pwaStaticRootDir: join(root, "pwa"),
      legacyTokenEnv: "MATHNOTES_HEADLESS_TOKEN",
      advertisedUrlEnv: "MATHNOTES_HEADLESS_URL"
    }));
    await expect(readNetworkNodeConfig(path)).resolves.toMatchObject({
      version: 2,
      host: "127.0.0.1",
      exposureMode: "tailscale_serve",
      advertisedUrlEnv: "MATHNOTES_HEADLESS_URL",
      pwaStaticRootDir: join(root, "pwa")
    });

    await writeFile(path, JSON.stringify({
      version: 2,
      port: 0,
      userDataDir: join(root, "runtime"),
      notesRootDir: join(root, "notes"),
      legacyTokenEnv: "MATHNOTES_HEADLESS_TOKEN",
      advertisedUrlEnv: "MATHNOTES_HEADLESS_URL"
    }));
    await expect(readNetworkNodeConfig(path)).rejects.toThrow("fixed non-zero port");

    await writeFile(path, JSON.stringify({
      version: 2,
      host: "0.0.0.0",
      port: 1051,
      userDataDir: join(root, "runtime"),
      notesRootDir: join(root, "notes"),
      legacyTokenEnv: "MATHNOTES_HEADLESS_TOKEN",
      advertisedUrlEnv: "MATHNOTES_HEADLESS_URL"
    }));
    await expect(readNetworkNodeConfig(path)).rejects.toThrow("must listen on 127.0.0.1");
  });

  it("allows an explicit safe private listener but rejects public and link-local hosts", async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-network-config-"));
    const path = join(root, "node.json");
    const base = {
      version: 2,
      exposureMode: "fixed_private",
      port: 1051,
      userDataDir: join(root, "runtime"),
      notesRootDir: join(root, "notes"),
      legacyTokenEnv: "MATHNOTES_HEADLESS_TOKEN"
    };
    await writeFile(path, JSON.stringify({ ...base, host: "100.92.105.105" }));
    await expect(readNetworkNodeConfig(path)).resolves.toMatchObject({
      host: "100.92.105.105",
      exposureMode: "fixed_private"
    });
    await writeFile(path, JSON.stringify({ ...base, host: "8.8.8.8" }));
    await expect(readNetworkNodeConfig(path)).rejects.toThrow("Tailscale or RFC1918");
    await writeFile(path, JSON.stringify({ ...base, host: "169.254.1.9" }));
    await expect(readNetworkNodeConfig(path)).rejects.toThrow("Tailscale or RFC1918");
  });

  it("rejects relative paths, token values disguised as names, and unknown fields", async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-network-config-"));
    const path = join(root, "node.json");
    const base = { version: 1, port: 0, userDataDir: root, notesRootDir: root, legacyTokenEnv: "secret-value" };
    await writeFile(path, JSON.stringify(base));
    await expect(readNetworkNodeConfig(path)).rejects.toThrow("environment variable name");
    await writeFile(path, JSON.stringify({ ...base, legacyTokenEnv: "MATHNOTES_TOKEN", token: "secret" }));
    await expect(readNetworkNodeConfig(path)).rejects.toThrow("Unknown network node config field: token");
    await writeFile(path, JSON.stringify({ ...base, legacyTokenEnv: "MATHNOTES_TOKEN", notesRootDir: "relative" }));
    await expect(readNetworkNodeConfig(path)).rejects.toThrow("notesRootDir must be an absolute path");
    await writeFile(path, JSON.stringify({
      ...base,
      version: 2,
      exposureMode: "loopback",
      legacyTokenEnv: "MATHNOTES_TOKEN",
      pwaStaticRootDir: "relative"
    }));
    await expect(readNetworkNodeConfig(path)).rejects.toThrow("pwaStaticRootDir must be an absolute path");
  });
});
