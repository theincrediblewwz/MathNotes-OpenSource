import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SpawnLike } from "./codexCliRecognitionProvider";
import { getRecognitionProviderCapability } from "./providerCapabilities";
import { readProviderConfig, type RecognitionProviderConfig, type RecognitionProviderId } from "./providerConfigStore";

export type ProviderHealthStatus = "ok" | "attention";

export type ProviderHealthCheck = {
  id: string;
  label: string;
  status: ProviderHealthStatus;
  detail: string;
};

export type ProviderHealthReport = {
  providerId: RecognitionProviderId;
  ok: boolean;
  summary: string;
  detail: string;
  checks: ProviderHealthCheck[];
};

export type CheckProviderHealthArgs = {
  rootDir: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  spawnImpl?: SpawnLike;
};

export async function checkProviderHealth(args: CheckProviderHealthArgs): Promise<ProviderHealthReport> {
  const config = await readProviderConfig({ rootDir: args.rootDir });
  if (config.providerId === "mock") {
    return {
      providerId: config.providerId,
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
    };
  }

  if (config.providerId === "codex_cli") {
    return checkCodexProviderHealth(config, args.spawnImpl);
  }

  return checkNetworkProviderHealth(config, args.env ?? process.env);
}

async function checkCodexProviderHealth(config: RecognitionProviderConfig, spawnImpl?: SpawnLike): Promise<ProviderHealthReport> {
  const doctor = await runCodexDoctor(config, spawnImpl);
  const runtimeLabel = config.codexRuntime === "wsl" ? `WSL Linux${config.wslDistro ? ` (${config.wslDistro})` : ""}` : "Windows direct";
  const authCheck = doctor.parsed?.checks?.["auth.credentials"];
  const authOk = authCheck?.status === "ok";
  const commandOk = Boolean(doctor.parsed?.codexVersion) || doctor.code === 0;
  const ok = commandOk && authOk;
  const summary = !commandOk ? "Codex CLI 不可用" : authOk ? "Codex CLI 可用" : "Codex CLI 未登录";
  const detail = !commandOk
    ? doctor.stderr || doctor.stdout || "Codex doctor failed without output"
    : authOk
      ? `codex ${doctor.parsed?.codexVersion ?? "version unknown"}`
      : authCheck?.remediation || authCheck?.summary || "Run codex login.";

  return {
    providerId: config.providerId,
    ok,
    summary,
    detail,
    checks: [
      {
        id: "runtime",
        label: "Runtime",
        status: "ok",
        detail: runtimeLabel
      },
      {
        id: "codex_command",
        label: "Codex command",
        status: commandOk ? "ok" : "attention",
        detail: commandOk ? `codex ${doctor.parsed?.codexVersion ?? "version unknown"}` : detail
      },
      {
        id: "codex_auth",
        label: "Codex auth",
        status: authOk ? "ok" : "attention",
        detail: authOk ? authCheck?.summary ?? "credentials found" : detail
      }
    ]
  };
}

type CodexDoctorJson = {
  overallStatus?: string;
  codexVersion?: string;
  checks?: Record<string, { status?: string; summary?: string; remediation?: string }>;
};

async function runCodexDoctor(
  config: RecognitionProviderConfig,
  spawnImpl?: SpawnLike
): Promise<{ code: number; stdout: string; stderr: string; parsed?: CodexDoctorJson }> {
  const commandPath = config.commandPath ?? "codex";
  const command =
    config.codexRuntime === "wsl"
      ? {
          command: "wsl.exe",
          args: [...(config.wslDistro ? ["--distribution", config.wslDistro] : []), "--exec", commandPath, "doctor", "--json"]
        }
      : {
          command: commandPath,
          args: ["doctor", "--json"]
        };
  const runner = spawnImpl ?? ((commandName, commandArgs, options) => spawn(commandName, commandArgs, options));
  const result = await runProcess(runner(command.command, command.args, { windowsHide: true }));
  try {
    return {
      ...result,
      parsed: JSON.parse(result.stdout) as CodexDoctorJson
    };
  } catch {
    return result;
  }
}

function runProcess(child: ChildProcessWithoutNullStreams): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
        code: code ?? 1
      })
    );
  });
}

function checkNetworkProviderHealth(
  config: RecognitionProviderConfig,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): ProviderHealthReport {
  const hasDirectApiKey = Boolean(config.apiKey?.trim());
  const hasEnvApiKey = Boolean(env[config.apiKeyEnvVar]);
  const hasApiKey = hasDirectApiKey || hasEnvApiKey;
  const capability = getRecognitionProviderCapability(config.providerId);
  const endpointDetail = config.providerId === "openai_vision" ? "OpenAI Responses API" : config.baseUrl ?? "";
  const apiKeyDetail = hasDirectApiKey ? "已填写 API 密钥。" : `已找到环境变量 ${config.apiKeyEnvVar}。`;
  if (hasApiKey) {
    return {
      providerId: config.providerId,
      ok: true,
      summary: `${capability.label} API 基础配置可用`,
      detail: hasDirectApiKey ? `已填写 API 密钥；模型 ${config.model}。` : `已找到环境变量 ${config.apiKeyEnvVar}；模型 ${config.model}。`,
      checks: [
        {
          id: "api_key",
          label: hasDirectApiKey ? "API 密钥" : "密钥环境变量",
          status: "ok",
          detail: apiKeyDetail
        },
        {
          id: "endpoint",
          label: "请求地址",
          status: "ok",
          detail: endpointDetail
        },
        {
          id: "model",
          label: "模型 ID",
          status: config.model ? "ok" : "attention",
          detail: config.model || "未配置模型。"
        },
        {
          id: "runtime",
          label: "运行日志",
          status: capability.runtimeLogKind === "api" ? "ok" : "attention",
          detail:
            capability.runtimeLogKind === "api"
              ? "API 请求、响应 chunk、限流、超时和重试事件。"
              : "当前识别服务不使用 API 运行日志。"
        }
      ]
    };
  }
  return {
    providerId: config.providerId,
    ok: false,
    summary: "识别服务缺少 API 密钥",
    detail: `未填写 API 密钥，也未找到环境变量 ${config.apiKeyEnvVar}。`,
    checks: [
      {
        id: "api_key",
        label: "API 密钥",
        status: "attention",
        detail: `未填写 API 密钥，也未找到环境变量 ${config.apiKeyEnvVar}。`
      },
      {
        id: "endpoint",
        label: "请求地址",
        status: "ok",
        detail: endpointDetail
      }
    ]
  };
}
