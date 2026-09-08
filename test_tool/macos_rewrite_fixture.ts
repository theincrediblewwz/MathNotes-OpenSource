// Test-only sidecar entry. Inject a deterministic provider; never configure or contact an AI endpoint.
import { startMacosSidecar, parseSidecarParentPid, isProcessAlive } from "../packages/core-server/src/sidecar/macosSidecar";
const running = await startMacosSidecar({
  token: process.env.MATHNOTES_LOCAL_TOKEN!, userDataDir: process.env.MATHNOTES_USER_DATA_DIR!,
  notesRootDir: process.env.MATHNOTES_NOTES_ROOT_DIR!, tempDir: process.env.MATHNOTES_TEMP_DIR!, appVersion: "rewrite-native-test",
  providerFactory: {
    async createRecognitionProvider() { throw new Error("Recognition is disabled in this fixture"); },
    async createAssistantProvider() {
      return { name: "synthetic-native-rewrite", async assist(input) {
        if (input.intent !== "session_rewrite") throw new Error("Only rewrite requests are expected");
        const snapshot = JSON.parse(input.markdownContext);
        return { markdown: JSON.stringify({ summary: "为未固定内容补充验收说明。", changes:
          snapshot.blocks.filter((block: any) => block.target && !block.locked).map((block: any) => ({
            blockId: block.blockId, markdown: block.markdown + "\n\nAI 原生验收修改", reason: "补充段落说明"
          })), lockedSuggestions: snapshot.blocks.filter((block: any) => block.target && block.locked).map((block: any) => ({
            blockId: block.blockId, reason: "本想补充推导说明，但保持固定原文"
          })) }) };
      } };
    }
  }
});
process.stdout.write(JSON.stringify(running.ready) + "\n");
const parent = parseSidecarParentPid(process.env.MATHNOTES_PARENT_PID, process.pid);
let stopping = false;
const timer = setInterval(() => { if (parent && !isProcessAlive(parent)) void stop(); }, 750);
async function stop() { if (stopping) return; stopping = true; clearInterval(timer); await running.stop(); }
process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());
