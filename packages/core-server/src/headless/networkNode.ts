import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  buildCompanionSessionSnapshot,
  readCompanionAsset
} from "../session/companionReadService";
import { FilesystemCompanionStore } from "../session/filesystemCompanionStore";
import { readNotesCatalog } from "../catalog/sessionCatalog";
import { RevisionEventLog } from "../events/revisionEventLog";
import { DeviceIdentityService } from "../device/deviceIdentityService";
import { NetworkApiServer, type StartedNetworkApiServer } from "../api/networkApiServer";
import type { NetworkNodeConfig } from "./networkNodeConfig";
import { resolveNetworkNodeRuntime } from "./networkNodeRuntime";

export type HeadlessNetworkNode = Readonly<{
  server: NetworkApiServer;
  started: StartedNetworkApiServer;
  localUrl: string;
  advertisedUrl: string;
  stop(): Promise<void>;
}>;

export async function startHeadlessNetworkNode(
  config: NetworkNodeConfig,
  environment: NodeJS.ProcessEnv = process.env
): Promise<HeadlessNetworkNode> {
  const runtime = resolveNetworkNodeRuntime(config, environment);
  await mkdir(config.userDataDir, { recursive: true });
  const store = new FilesystemCompanionStore(config.notesRootDir);
  const targets = async () => {
    const catalog = await readNotesCatalog({ rootDir: config.notesRootDir });
    return catalog.notebooks.flatMap((notebook) => notebook.sessions.map((session) => ({
      notebookId: notebook.notebookId,
      notebookTitle: notebook.title,
      sessionId: session.sessionId,
      title: session.title
    })));
  };
  const revisionEventLog = new RevisionEventLog({
    filePath: join(config.userDataDir, "network-events.json")
  });
  const deviceIdentityService = new DeviceIdentityService({
    filePath: join(config.userDataDir, "companion-device-identities.json")
  });
  await deviceIdentityService.start();
  const server = new NetworkApiServer({
    host: config.host,
    port: config.port,
    token: runtime.token,
    getPairingTargets: targets,
    getCompanionSession: (notebookId, sessionId) => buildCompanionSessionSnapshot({ store, notebookId, sessionId }),
    getCompanionAsset: (notebookId, sessionId, assetPath) => readCompanionAsset({ store, notebookId, sessionId, assetPath }),
    revisionEventLog,
    deviceIdentityService,
    pwaStaticRootDir: config.pwaStaticRootDir
  });
  const started = await server.start();
  return {
    server,
    started,
    localUrl: started.url,
    advertisedUrl: runtime.advertisedUrl ?? started.url,
    stop: () => server.stop()
  };
}
