import { buildSessionRecognitionContext } from "@mathnotes/core-server";
import type { BlockStore } from "./blockStore";
import type { RecognitionJob } from "./recognitionQueue";

export async function buildRecognitionContextForJob(
  store: BlockStore,
  job: RecognitionJob
): Promise<{ version: 1; summary: string; fingerprint: string } | undefined> {
  const session = await store.readSession(job.notebookId, job.sessionId);
  const snapshot = await buildSessionRecognitionContext({
    sessionDir: store.getSessionDir(job.notebookId, job.sessionId),
    session,
    beforeBlockId: job.imageBlockId,
    persist: false
  });
  return snapshot.summary ? {
    version: snapshot.version,
    summary: snapshot.summary,
    fingerprint: snapshot.fingerprint
  } : undefined;
}
