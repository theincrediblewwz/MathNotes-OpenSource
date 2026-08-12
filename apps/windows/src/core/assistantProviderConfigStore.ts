import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  normalizeProviderConfig,
  readProviderConfigForPurpose,
  type RecognitionProviderConfig,
  type RecognitionProviderConfigInput
} from "./providerConfigStore";

export type AssistantProviderConfigInput = RecognitionProviderConfigInput;

export type AssistantProviderConfig = RecognitionProviderConfig & {
  purpose: "assistant";
  inherited: boolean;
};

export type ReadAssistantProviderConfigArgs = {
  rootDir: string;
};

export type WriteAssistantProviderConfigArgs = ReadAssistantProviderConfigArgs & {
  config: RecognitionProviderConfigInput | null;
};

/**
 * Reads the effective assistant (dialogue) profile.
 *
 * Until settings/assistant-provider.json exists, the effective profile is the
 * current recognition profile resolved at read time. The inherited config is
 * exposed with `inherited: true` but is never copied into the dialogue file,
 * so the recognition secret stays in settings/provider.json only.
 */
export async function readAssistantProviderConfig(args: ReadAssistantProviderConfigArgs): Promise<AssistantProviderConfig> {
  try {
    const stored = JSON.parse(await readFile(assistantProviderConfigPath(args.rootDir), "utf8")) as Partial<RecognitionProviderConfigInput>;
    return {
      ...normalizeProviderConfig(stored, "assistant"),
      purpose: "assistant",
      inherited: false
    };
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) {
      const recognition = await readProviderConfigForPurpose({ rootDir: args.rootDir, purpose: "assistant" });
      return {
        ...recognition,
        purpose: "assistant",
        inherited: true
      };
    }

    throw error;
  }
}

/**
 * Writes or clears only settings/assistant-provider.json.
 *
 * Passing `config: null` removes the dialogue profile so future reads inherit
 * the recognition profile again. The recognition file is never touched.
 */
export async function writeAssistantProviderConfig(args: WriteAssistantProviderConfigArgs): Promise<AssistantProviderConfig> {
  const target = assistantProviderConfigPath(args.rootDir);
  if (args.config === null) {
    await rm(target, { force: true });
    return readAssistantProviderConfig(args);
  }

  const normalized = normalizeProviderConfig(args.config, "assistant");
  const tmp = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    tmp,
    `${JSON.stringify(
      {
        providerId: normalized.providerId,
        model: normalized.model,
        apiKey: normalized.apiKey,
        apiKeyEnvVar: normalized.apiKeyEnvVar,
        baseUrl: normalized.baseUrl,
        commandPath: normalized.commandPath,
        codexRuntime: normalized.codexRuntime,
        wslDistro: normalized.wslDistro
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await rename(tmp, target);
  return {
    ...normalized,
    purpose: "assistant",
    inherited: false
  };
}

function assistantProviderConfigPath(rootDir: string): string {
  return join(rootDir, "settings", "assistant-provider.json");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
