import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runProviderTurnAcceptance, type ProviderTurnAcceptanceReport } from "../apps/windows/src/core/providerTurnAcceptance";
import { readProviderConfig } from "../apps/windows/src/core/providerConfigStore";
import { createRecognitionProviderFromConfig } from "../apps/windows/src/core/recognitionProviderFactory";
import { readUserSettings } from "../apps/windows/src/core/userSettingsStore";

export type ProviderTurnAcceptanceCliArgs = {
  imagePath: string;
  notesRoot?: string;
  outputRoot?: string;
  allowMock: boolean;
};

export function parseProviderTurnAcceptanceArgs(argv: string[]): ProviderTurnAcceptanceCliArgs {
  const parsed: ProviderTurnAcceptanceCliArgs = {
    imagePath: "",
    allowMock: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-mock") {
      parsed.allowMock = true;
      continue;
    }
    if (argument === "--image" || argument === "--notes-root" || argument === "--output-root") {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a path value`);
      }
      if (argument === "--image") parsed.imagePath = value;
      if (argument === "--notes-root") parsed.notesRoot = value;
      if (argument === "--output-root") parsed.outputRoot = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!parsed.imagePath) {
    throw new Error("--image is required; select one image explicitly for this Provider turn");
  }
  return parsed;
}

export async function runProviderTurnAcceptanceCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<ProviderTurnAcceptanceReport> {
  const options = parseProviderTurnAcceptanceArgs(argv);
  const userDataDir = resolve(
    env.MATHNOTES_USER_DATA ?? join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Electron")
  );
  const fallbackNotesRoot = join(userDataDir, "MyMathNotes");
  const settings = await readUserSettings({ userDataDir, fallbackNotesRootDir: fallbackNotesRoot });
  const notesRoot = resolve(options.notesRoot ?? env.MATHNOTES_ROOT ?? settings.notesRootDir);
  const outputRoot = resolve(options.outputRoot ?? join(notesRoot, "provider-acceptance-runs"));
  const providerConfig = await readProviderConfig({ rootDir: notesRoot });
  if (providerConfig.providerId === "mock" && !options.allowMock) {
    throw new Error("The selected Provider is the mock pipeline validator. Pass --allow-mock only for deterministic smoke tests.");
  }

  const provider = await createRecognitionProviderFromConfig({ rootDir: notesRoot, env });
  const report = await runProviderTurnAcceptance({
    outputRoot,
    imagePath: resolve(options.imagePath),
    provider,
    providerConfig,
    now: new Date().toISOString()
  });
  process.stdout.write(`Provider: ${report.provider.label}\n`);
  process.stdout.write(`Status: ${report.result.status}\n`);
  process.stdout.write(`Report: ${report.artifacts.reportPath}\n`);
  return report;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entryPath && import.meta.url === entryPath) {
  runProviderTurnAcceptanceCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Provider acceptance failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
