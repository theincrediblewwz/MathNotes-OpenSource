import type { BlockRef, RecognitionInput, RecognitionProvider } from "@mathnotes/shared";
import type { BlockStore } from "./blockStore";
import { BlockWriter } from "./blockWriter";
import { readRecognitionJobs, upsertRecognitionJob } from "./recognitionJobLog";
import {
  buildRecognitionDraftMarkdown,
  buildRecognitionFailureMarkdown,
  buildRecognitionCancelledMarkdown,
  buildRecognitionAnomalyMarkdown,
  eventLevel,
  eventMessage,
  recognitionProviderLabel,
  type RecognitionJob,
  type RecognitionRuntimeEvent
} from "./recognitionQueue";
import { validateFaithfulTranscriptionOutput } from "./faithfulTranscriptionPrompt";
import { StreamingOutputGuard, type OutputGuardReason } from "./streamingOutputGuard";
import { resolve } from "node:path";

export type RetryRecognitionJobArgs = {
  rootDir: string;
  store: BlockStore;
  provider: RecognitionProvider;
  notebookId: string;
  sessionId: string;
  jobId: string;
  now: string;
  abortSignal?: AbortSignal;
  onJobChanged?: (job: RecognitionJob) => void | Promise<void>;
  onRuntimeEvent?: (event: RecognitionRuntimeEvent) => void | Promise<void>;
};

const activeRetries = new Set<string>();

export async function retryRecognitionJob(args: RetryRecognitionJobArgs): Promise<RecognitionJob> {
  const root = resolve(args.rootDir);
  const key = JSON.stringify([process.platform === "win32" ? root.toLowerCase() : root, args.notebookId, args.sessionId, args.jobId]);
  if (activeRetries.has(key)) throw new Error("该识别任务仍在进行中，请等待完成或中断后重试。");
  activeRetries.add(key);
  try { return await runRecognitionRetry(args); }
  finally { activeRetries.delete(key); }
}

async function runRecognitionRetry(args: RetryRecognitionJobArgs): Promise<RecognitionJob> {
  const jobs = await readRecognitionJobs({
    rootDir: args.rootDir,
    notebookId: args.notebookId,
    sessionId: args.sessionId
  });
  const job = jobs.find((candidate) => candidate.id === args.jobId);
  if (!job) {
    throw new Error(`Recognition job not found: ${args.jobId}`);
  }
  let transcriptBlock = await findReusableTranscriptBlock(args.store, job);
  const preserveTranscript = Boolean(transcriptBlock && (job.status === "succeeded" || job.hasSuccessfulTranscript));
  const startedAt = Date.now();
  const nextAttempt = job.attempts + 1;
  const providerLabel = recognitionProviderLabel(args.provider.name);

  const runningJob: RecognitionJob = {
    ...job,
    now: args.now,
    status: "running",
    hasSuccessfulTranscript: preserveTranscript,
    attempts: nextAttempt,
    maxAttempts: Math.max(job.maxAttempts, nextAttempt),
    error: undefined,
    failureKind: undefined,
    providerName: args.provider.name,
    providerLabel,
    warnings: undefined,
    timing: { acceptedAt: args.now, runningAt: new Date(startedAt).toISOString(), queueMs: 0 }
  };
  await upsertRecognitionJob({ rootDir: args.rootDir, job: runningJob });
  await args.onJobChanged?.(runningJob);

  const writer = new BlockWriter(args.store);
  const runAbortController = new AbortController();
  const forwardAbort = () => runAbortController.abort(args.abortSignal?.reason);
  if (args.abortSignal?.aborted) {
    forwardAbort();
  } else {
    args.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const outputGuard = new StreamingOutputGuard();
  let outputAnomaly: { reason: OutputGuardReason; safeText: string; detail: string } | undefined;
  let anomalyWarningSent = false;
  let updateChain = Promise.resolve();

  try {
    await args.onRuntimeEvent?.({
      job: { ...runningJob },
      level: "info",
      message: `当前识别服务：${providerLabel}。`,
      previewChanged: false
    });

    const supportsEvents = Boolean(args.provider.transcribeWithEvents);
    let stdout = "";
    const runtimeLines: string[] = [];

    const updateDraft = (markdown: string, eventMessageText: string, level: RecognitionRuntimeEvent["level"]) => {
      const draftBlock = transcriptBlock;
      if (!draftBlock) return;
      updateChain = updateChain.then(async () => {
        await writer.updateAiTranscript({
          notebookId: job.notebookId,
          sessionId: job.sessionId,
          blockId: draftBlock.id,
          markdown,
          now: new Date().toISOString()
        });
        await args.onRuntimeEvent?.({
          job: { ...runningJob, transcriptBlockId: draftBlock.id },
          level,
          message: eventMessageText,
          transcriptBlockId: draftBlock.id,
          previewChanged: true
        });
      });
    };

    if (supportsEvents && !preserveTranscript) {
      const draftMarkdown = buildRecognitionDraftMarkdown([`${providerLabel} 正在准备识别。`], "", providerLabel);
      transcriptBlock =
        transcriptBlock ??
        (await writer.writeAiTranscript({
          notebookId: job.notebookId,
          sessionId: job.sessionId,
          markdown: draftMarkdown,
          fromAssets: [job.assetPath],
          insertAfterBlockId: job.imageBlockId,
          now: args.now
        }));
      if (transcriptBlock.id === job.transcriptBlockId) {
        await writer.updateAiTranscript({
          notebookId: job.notebookId,
          sessionId: job.sessionId,
          blockId: transcriptBlock.id,
          markdown: draftMarkdown,
          now: args.now
        });
      }
      runningJob.transcriptBlockId = transcriptBlock.id;
      await upsertRecognitionJob({ rootDir: args.rootDir, job: runningJob });
      await args.onJobChanged?.(runningJob);
      await args.onRuntimeEvent?.({
        job: { ...runningJob },
        level: "info",
        message: "已创建流式识别草稿块。",
        transcriptBlockId: transcriptBlock.id,
        previewChanged: true
      });
    }

    const transcribeInput: RecognitionInput = {
      imagePaths: [job.imagePath],
      mode: "faithful",
      outputFormat: "markdown",
      sessionId: job.sessionId,
      abortSignal: runAbortController.signal
    };
    runAbortController.signal.throwIfAborted();
    const providerStartedAt = Date.now();
    runningJob.timing!.providerStartedAt = new Date(providerStartedAt).toISOString();
    const transcript = args.provider.transcribeWithEvents
      ? await args.provider.transcribeWithEvents({
          ...transcribeInput,
          onEvent: (event) => {
            if (event.type === "stdout" && outputAnomaly) {
              return;
            }
            const message = eventMessage(event);
            if (message) {
              runtimeLines.push(message);
            }
            if (event.type === "stdout") {
              if (!runningJob.timing!.firstOutputAt) {
                runningJob.timing!.firstOutputAt = new Date().toISOString();
                runningJob.timing!.firstOutputMs = Date.now() - providerStartedAt;
              }
              const observation = outputGuard.observe(event.text);
              stdout = observation.state === "tripped" ? observation.safeText : observation.text;
              if (observation.state !== "healthy" && !anomalyWarningSent) {
                anomalyWarningSent = true;
                void args.onRuntimeEvent?.({
                  job: { ...runningJob },
                  level: "warning",
                  message: "检测到疑似重复输出；继续异常将自动停止。",
                  transcriptBlockId: transcriptBlock?.id,
                  previewChanged: false
                });
              }
              if (observation.state === "tripped") {
                outputAnomaly = {
                  reason: observation.reason ?? "low_diversity",
                  safeText: observation.safeText,
                  detail: observation.message ?? "检测到持续异常输出。"
                };
                runAbortController.abort(new Error("Recognition output anomaly"));
              }
            }
            const level = eventLevel(event);
            void args.onRuntimeEvent?.({
              job: { ...runningJob },
              level,
              message: message ?? "",
              transcriptBlockId: transcriptBlock?.id,
              previewChanged: false
            });
            if (transcriptBlock && !preserveTranscript) {
              updateDraft(buildRecognitionDraftMarkdown(runtimeLines, stdout, providerLabel), message ?? "draft updated", level);
            }
          }
        })
      : await args.provider.transcribe(transcribeInput);
    if (outputAnomaly) {
      throw new Error("Recognition output anomaly");
    }
    runAbortController.signal.throwIfAborted();
    await updateChain;
    runningJob.timing!.providerMs = Date.now() - providerStartedAt;

    const block =
      transcriptBlock ??
      (await writer.writeAiTranscript({
        notebookId: job.notebookId,
        sessionId: job.sessionId,
        markdown: transcript.markdown,
        fromAssets: [job.assetPath],
        insertAfterBlockId: job.imageBlockId,
        now: args.now
      }));

    if (transcriptBlock) {
      await writer.updateAiTranscript({
        notebookId: job.notebookId,
        sessionId: job.sessionId,
        blockId: transcriptBlock.id,
        markdown: transcript.markdown,
        now: new Date().toISOString()
      });
      await args.onRuntimeEvent?.({
        job: { ...runningJob, transcriptBlockId: transcriptBlock.id },
        level: "info",
        message: "最终 Markdown 已写入草稿块。",
        transcriptBlockId: transcriptBlock.id,
        previewChanged: true
      });
    }

    await args.onRuntimeEvent?.({
      job: { ...runningJob, transcriptBlockId: block.id },
      level: "info",
      message: `识别服务已完成：${providerLabel}。`,
      transcriptBlockId: block.id,
      previewChanged: true
    });

    const succeededJob: RecognitionJob = {
      ...runningJob,
      status: "succeeded",
      hasSuccessfulTranscript: true,
      transcriptBlockId: block.id,
      warnings: mergeWarnings(transcript.warnings, validateFaithfulTranscriptionOutput(transcript.markdown)),
      error: undefined,
      failureKind: undefined,
      timing: { ...runningJob.timing!, completedAt: new Date().toISOString(), totalMs: Date.now() - startedAt }
    };
    await upsertRecognitionJob({ rootDir: args.rootDir, job: succeededJob });
    await args.onJobChanged?.(succeededJob);
    return succeededJob;
  } catch (error) {
    await updateChain.catch(() => undefined);
    const cancelled = !outputAnomaly && (args.abortSignal?.aborted || isRecognitionCancellation(error));
    const message = outputAnomaly
      ? `异常输出已停止：${outputAnomaly.detail}`
      : cancelled
        ? "用户已中断识别。"
        : error instanceof Error
          ? error.message
          : "unknown error";
    if (transcriptBlock && !preserveTranscript) {
      await writer.updateAiTranscript({
        notebookId: job.notebookId,
        sessionId: job.sessionId,
        blockId: transcriptBlock.id,
        markdown: outputAnomaly
          ? buildRecognitionAnomalyMarkdown(outputAnomaly.safeText, providerLabel, outputAnomaly.detail)
          : cancelled
            ? buildRecognitionCancelledMarkdown(providerLabel)
            : buildRecognitionFailureMarkdown(message, providerLabel),
        now: new Date().toISOString()
      }).catch(() => undefined); // A newly applied user lock also protects failure/cancel draft writes.
    }
    const failedJob: RecognitionJob = {
      ...runningJob,
      status: cancelled ? "cancelled" : "failed",
      error: message,
      failureKind: outputAnomaly ? "output_anomaly" : undefined,
      timing: { ...runningJob.timing!, completedAt: new Date().toISOString(), totalMs: Date.now() - startedAt }
    };
    await upsertRecognitionJob({ rootDir: args.rootDir, job: failedJob });
    await args.onRuntimeEvent?.({
      job: { ...failedJob },
      level: outputAnomaly ? "warning" : cancelled ? "info" : "error",
      message: outputAnomaly
        ? `异常输出已自动停止（${providerLabel}）：${outputAnomaly.detail}`
        : cancelled
          ? `识别已中断：${providerLabel}。`
          : `识别服务失败（${providerLabel}）：${failedJob.error}`,
      transcriptBlockId: transcriptBlock?.id ?? failedJob.transcriptBlockId,
      previewChanged: Boolean(transcriptBlock && !preserveTranscript)
    });
    await args.onJobChanged?.(failedJob);
    return failedJob;
  } finally {
    args.abortSignal?.removeEventListener("abort", forwardAbort);
  }
}

async function findReusableTranscriptBlock(store: BlockStore, job: RecognitionJob): Promise<BlockRef | undefined> {
  if (!job.transcriptBlockId) {
    return undefined;
  }

  const session = await store.readSession(job.notebookId, job.sessionId);
  const block = session.blocks.find((candidate) => candidate.id === job.transcriptBlockId);
  if (!block || block.type !== "markdown" || block.source !== "ai_transcription") {
    return undefined;
  }
  if (block.fromAssets?.length && !block.fromAssets.includes(job.assetPath)) {
    throw new Error("原识别块的素材关联已改变，未执行重新识别。");
  }
  if (block.readonly || !block.editableByAi || block.status === "locked" || session.locks.some(lock => lock.blockId === block.id)) {
    throw new Error("该块或其中的选区已锁定，请先解除锁定后重新识别。");
  }

  return block;
}

function mergeWarnings(...groups: Array<string[] | undefined>): string[] | undefined {
  const warnings = groups.flatMap((group) => group ?? []);
  if (warnings.length === 0) {
    return undefined;
  }

  return [...new Set(warnings)];
}

function isRecognitionCancellation(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || /cancelled|canceled|aborted|用户已中断/i.test(error.message);
}
