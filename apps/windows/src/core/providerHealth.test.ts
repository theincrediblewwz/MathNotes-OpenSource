import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnLike } from "./codexCliRecognitionProvider";
import { checkProviderHealth } from "./providerHealth";
import { writeProviderConfig } from "./providerConfigStore";
import { fakeChildProcess } from "./testHelpers/fakeChildProcess";

describe("checkProviderHealth", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-provider-health-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("reports mock provider as ready", async () => {
    await expect(checkProviderHealth({ rootDir, env: {} })).resolves.toEqual({
      providerId: "mock",
      ok: true,
      summary: "假识别服务可用",
      detail: "假识别服务不调用外部模型，只适合验证上传、写入、预览和导出管线。",
      checks: [
        {
          id: "mock",
          label: "假识别服务",
          status: "ok",
          detail: "已启用本地占位识别。"
        }
      ]
    });
  });

  it("reports missing API key for network providers", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "glm_5_2",
        model: "glm-5.2",
        apiKeyEnvVar: "MATHNOTES_MISSING_ZAI_KEY",
        baseUrl: "https://example.test/chat/completions",
        commandPath: "",
        codexRuntime: "windows",
        wslDistro: ""
      }
    });

    const report = await checkProviderHealth({ rootDir, env: {} });

    expect(report.ok).toBe(false);
    expect(report.summary).toBe("识别服务缺少 API 密钥");
    expect(report.checks).toEqual([
      {
        id: "api_key",
        label: "API 密钥",
        status: "attention",
        detail: "未填写 API 密钥，也未找到环境变量 MATHNOTES_MISSING_ZAI_KEY。"
      },
      {
        id: "endpoint",
        label: "请求地址",
        status: "ok",
        detail: "https://example.test/chat/completions"
      }
    ]);
  });

  it("reports API provider capability details when network providers are configured", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "mimo_2_5",
        model: "mimo-v2.5",
        apiKeyEnvVar: "MATHNOTES_MIMO_KEY",
        baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
        commandPath: "",
        codexRuntime: "windows",
        wslDistro: ""
      }
    });

    const report = await checkProviderHealth({ rootDir, env: { MATHNOTES_MIMO_KEY: "test-key" } });

    expect(report.ok).toBe(true);
    expect(report.summary).toBe("Mimo v2.5 API 基础配置可用");
    expect(report.detail).toBe("已找到环境变量 MATHNOTES_MIMO_KEY；模型 mimo-v2.5。");
    expect(report.checks).toEqual([
      {
        id: "api_key",
        label: "密钥环境变量",
        status: "ok",
        detail: "已找到环境变量 MATHNOTES_MIMO_KEY。"
      },
      {
        id: "endpoint",
        label: "请求地址",
        status: "ok",
        detail: "https://api.xiaomimimo.com/v1/chat/completions"
      },
      {
        id: "model",
        label: "模型 ID",
        status: "ok",
        detail: "mimo-v2.5"
      },
      {
        id: "runtime",
        label: "运行日志",
        status: "ok",
        detail: "API 请求、响应 chunk、限流、超时和重试事件。"
      }
    ]);
  });

  it("reports direct API keys as configured without exposing the key", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "mimo_2_5",
        model: "mimo-v2.5",
        apiKey: "super-secret-key",
        apiKeyEnvVar: "MATHNOTES_MIMO_KEY",
        baseUrl: "https://api.xiaomimimo.com/v1",
        commandPath: "",
        codexRuntime: "windows",
        wslDistro: ""
      }
    });

    const report = await checkProviderHealth({ rootDir, env: {} });

    expect(report.ok).toBe(true);
    expect(report.summary).toBe("Mimo v2.5 API 基础配置可用");
    expect(report.detail).toBe("已填写 API 密钥；模型 mimo-v2.5。");
    expect(JSON.stringify(report)).not.toContain("super-secret-key");
    expect(report.checks).toContainEqual({
      id: "api_key",
      label: "API 密钥",
      status: "ok",
      detail: "已填写 API 密钥。"
    });
  });

  it("checks Codex CLI availability in WSL", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnImpl: SpawnLike = (command, args) => {
      calls.push({ command, args });
      return fakeChildProcess({
        stdout: JSON.stringify({
          overallStatus: "ok",
          codexVersion: "1.0.0",
          checks: {
            "auth.credentials": {
              status: "ok",
              summary: "credentials found"
            }
          }
        }),
        stderr: "",
        code: 0
      });
    };
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "codex_cli",
        model: "",
        apiKeyEnvVar: "",
        baseUrl: "",
        commandPath: "codex",
        codexRuntime: "wsl",
        wslDistro: "Ubuntu-24.04"
      }
    });

    const report = await checkProviderHealth({ rootDir, env: {}, spawnImpl });

    expect(report.ok).toBe(true);
    expect(report.summary).toBe("Codex CLI 可用");
    expect(report.detail).toBe("codex 1.0.0");
    expect(calls[0]).toEqual({
      command: "wsl.exe",
      args: ["--distribution", "Ubuntu-24.04", "--exec", "codex", "doctor", "--json"]
    });
  });

  it("returns actionable Codex CLI failure details", async () => {
    const spawnImpl: SpawnLike = () =>
      fakeChildProcess({
        stdout: JSON.stringify({
          overallStatus: "fail",
          codexVersion: "1.0.0",
          checks: {
            "auth.credentials": {
              status: "fail",
              summary: "no Codex credentials were found",
              remediation: "Run codex login."
            }
          }
        }),
        stderr: "",
        code: 1
      });
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "codex_cli",
        model: "",
        apiKeyEnvVar: "",
        baseUrl: "",
        commandPath: "codex",
        codexRuntime: "wsl",
        wslDistro: "Ubuntu-24.04"
      }
    });

    const report = await checkProviderHealth({ rootDir, env: {}, spawnImpl });

    expect(report.ok).toBe(false);
    expect(report.summary).toBe("Codex CLI 未登录");
    expect(report.detail).toMatch(/Run codex login/);
  });
});
