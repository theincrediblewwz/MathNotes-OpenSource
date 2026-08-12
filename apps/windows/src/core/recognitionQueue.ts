import type { BlockRef, RecognitionInput, RecognitionProvider, RecognitionProviderEvent } from "@mathnotes/shared";
import type { BlockWriter } from "./blockWriter";
import { validateFaithfulTranscriptionOutput } from "./faithfulTranscriptionPrompt";
import { getRecognitionProviderCapability } from "./providerCapabilities";
import type { RecognitionProviderId } from "./providerConfigStore";
import { StreamingOutputGuard, type OutputGuardReason } from "./streamingOutputGuard";

export type RecognitionJobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type RecognitionFailureKind = "output_anomaly";

export type RecognitionTiming = {
  acceptedAt: string;
  runningAt?: string;
  providerStartedAt?: string;
  firstOutputAt?: string;
  completedAt?: string;
  queueMs?: number;
  firstOutputMs?: number;
  providerMs?: number;
  totalMs?: number;
};

export type RecognitionJob = {
  id: string;
  notebookId: string;
  sessionId: string;
  imageBlockId: string;
  assetPath: string;
  imagePath: string;
  now: string;
  status: RecognitionJobStatus;
  attempts: number;
  maxAttempts: number;
  providerName?: string;
  providerLabel?: string;
  transcriptBlockId?: string;
  warnings?: string[];
  error?: string;
  failureKind?: RecognitionFailureKind;
  batchId?: string;
  pageNumber?: number;
  pageCount?: number;
  timing?: RecognitionTiming;
  recognitionContextVersion?: 1;
  recognitionContext?: string;
  recognitionContextFingerprint?: string;
};

export type RecognitionJobContext = {
  version: 1;
  summary: string;
  fingerprint: string;
};

export type EnqueueRecognitionJobArgs = {
  notebookId: string;
  sessionId: string;
  imageBlockId: string;
  assetPath: string;
  imagePath: string;
  now: string;
  jobId?: string;
  transcriptBlockId?: string;
  batchId?: string;
  pageNumber?: number;
  pageCount?: number;
};

export type RecognitionRuntimeEvent = {
  job: RecognitionJob;
  level: "info" | "stdout" | "stderr" | "warning" | "error";
  message: string;
  transcriptBlockId?: string;
  previewChanged?: boolean;
};

export class RecognitionQueue {
  private readonly jobs: RecognitionJob[] = [];
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly deps: {
      provider: RecognitionProvider;
      writer: Pick<BlockWriter, "writeAiTranscript" | "updateAiTranscript">;
      maxAttempts?: number;
      draftUpdateIntervalMs?: number;
      buildContext?: (job: RecognitionJob) => Promise<RecognitionJobContext | undefined>;
      onJobChanged?: (job: RecognitionJob) => void | Promise<void>;
      onRuntimeEvent?: (event: RecognitionRuntimeEvent) => void | Promise<void>;
    }
  ) {}

  enqueue(args: EnqueueRecognitionJobArgs): RecognitionJob {
    const job = this.createJob(args);
    this.jobs.push(job);
    void this.notifyJobChanged(job);
    return { ...job };
  }

  async enqueuePersisted(args: EnqueueRecognitionJobArgs): Promise<RecognitionJob> {
    const job = this.createJob(args);
    this.jobs.push(job);
    await this.notifyJobChanged(job);
    return { ...job };
  }

  restorePersisted(job: RecognitionJob): RecognitionJob {
    const existing = this.jobs.find((candidate) => candidate.id === job.id);
    if (existing) {
      return { ...existing };
    }
    const restored = {
      ...job,
      status: job.status === "running" ? ("failed" as const) : job.status,
      error: job.status === "running" ? job.error ?? "上次识别运行被中断，请重试。" : job.error
    };
    this.jobs.push(restored);
    return { ...restored };
  }

  getJob(id: string): RecognitionJob | undefined {
    const job = this.jobs.find((candidate) => candidate.id === id);
    return job ? { ...job } : undefined;
  }

  listJobs(): RecognitionJob[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  cancel(jobId: string): RecognitionJob | undefined {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job || (job.status !== "running" && job.status !== "pending")) {
      return job ? { ...job } : undefined;
    }

    const wasRunning = job.status === "running";
    job.status = "cancelled";
    job.error = "用户已中断识别。";
    if (wasRunning) this.abortControllers.get(jobId)?.abort();
    void this.notifyJobChanged(job);
    return { ...job };
  }

  async processNext(jobId?: string): Promise<RecognitionJob | null> {
    const job = this.jobs.find(
      (candidate) =>
        (!jobId || candidate.id === jobId) &&
        (candidate.status === "pending" || candidate.status === "failed") &&
        candidate.attempts < candidate.maxAttempts
    );
    if (!job) {
      return null;
    }

    job.status = "running";
    job.attempts += 1;
    job.error = undefined;
    job.failureKind = undefined;
    job.providerName = this.deps.provider.name;
    job.providerLabel = recognitionProviderLabel(this.deps.provider.name);
    const runningAtMs = Date.now();
    job.timing = {
      acceptedAt: job.timing?.acceptedAt ?? job.now,
      runningAt: new Date(runningAtMs).toISOString(),
      queueMs: elapsedFromIso(job.timing?.acceptedAt ?? job.now, runningAtMs)
    };
    const abortController = new AbortController();
    this.abortControllers.set(job.id, abortController);
    await this.notifyJobChanged(job);

    let transcriptBlock: BlockRef | undefined = transcriptBlockFromJob(job);
    const providerLabel = job.providerLabel;
    const outputGuard = new StreamingOutputGuard();
    let outputAnomaly: { reason: OutputGuardReason; safeText: string; detail: string } | undefined;
    let anomalyWarningSent = false;
    let updateChain = Promise.resolve();
    let pendingDraft: { markdown: string; event?: RecognitionProviderEvent } | undefined;
    let draftUpdateTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      await this.notifyRuntimeEvent({
        job: { ...job },
        level: "info",
        message: `当前识别服务：${providerLabel}。`,
        previewChanged: false
      });

      const supportsEvents = Boolean(this.deps.provider.transcribeWithEvents);
      let stdout = "";
      const runtimeLines: string[] = [];

      const persistDraft = (markdown: string, event?: RecognitionProviderEvent) => {
        const draftBlock = transcriptBlock;
        if (!draftBlock) return;
        updateChain = updateChain.then(async () => {
          await this.deps.writer.updateAiTranscript({
            notebookId: job.notebookId,
            sessionId: job.sessionId,
            blockId: draftBlock.id,
            markdown,
            now: new Date().toISOString()
          });
          await this.notifyRuntimeEvent({
            job: { ...job, transcriptBlockId: draftBlock.id },
            level: eventLevel(event),
            message: eventMessage(event) ?? "draft updated",
            transcriptBlockId: draftBlock.id,
            previewChanged: true
          });
        });
      };

      const flushPendingDraft = () => {
        if (draftUpdateTimer) {
          clearTimeout(draftUpdateTimer);
          draftUpdateTimer = undefined;
        }
        const draft = pendingDraft;
        pendingDraft = undefined;
        if (draft) persistDraft(draft.markdown, draft.event);
        return updateChain;
      };

      const updateDraft = (markdown: string, event?: RecognitionProviderEvent) => {
        pendingDraft = { markdown, event };
        if (draftUpdateTimer) return;
        draftUpdateTimer = setTimeout(() => {
          draftUpdateTimer = undefined;
          void flushPendingDraft();
        }, this.deps.draftUpdateIntervalMs ?? 80);
      };

      if (supportsEvents) {
        const draftMarkdown = buildRecognitionDraftMarkdown([`${providerLabel} 正在准备识别。`], "", providerLabel);
        if (transcriptBlock) {
          await this.deps.writer.updateAiTranscript({
            notebookId: job.notebookId,
            sessionId: job.sessionId,
            blockId: transcriptBlock.id,
            markdown: draftMarkdown,
            now: new Date().toISOString()
          });
        } else {
          transcriptBlock = await this.deps.writer.writeAiTranscript({
            notebookId: job.notebookId,
            sessionId: job.sessionId,
            markdown: draftMarkdown,
            fromAssets: [job.assetPath],
            insertAfterBlockId: job.imageBlockId,
            now: job.now
          });
        }
        job.transcriptBlockId = transcriptBlock.id;
        await this.notifyJobChanged(job);
        await this.notifyRuntimeEvent({
          job,
          level: "info",
          message: "已创建流式识别草稿块。",
          transcriptBlockId: transcriptBlock.id,
          previewChanged: true
        });
      }

      if (!job.recognitionContext && this.deps.buildContext) {
        const context = await this.deps.buildContext({ ...job });
        if (context?.summary) {
          job.recognitionContextVersion = context.version;
          job.recognitionContext = context.summary;
          job.recognitionContextFingerprint = context.fingerprint;
          await this.notifyJobChanged(job);
        }
      }
      const transcribeInput: RecognitionInput = {
        imagePaths: [job.imagePath],
        mode: "faithful",
        outputFormat: "markdown",
        sessionId: job.sessionId,
        context: job.recognitionContext,
        abortSignal: abortController.signal
      };
      const providerStartedAtMs = Date.now();
      job.timing.providerStartedAt = new Date(providerStartedAtMs).toISOString();
      let firstOutputRecorded = false;
      const transcript = this.deps.provider.transcribeWithEvents
        ? await this.deps.provider.transcribeWithEvents({
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
                if (!firstOutputRecorded && event.text.length > 0) {
                  firstOutputRecorded = true;
                  const firstOutputAtMs = Date.now();
                  job.timing = {
                    ...job.timing!,
                    firstOutputAt: new Date(firstOutputAtMs).toISOString(),
                    firstOutputMs: firstOutputAtMs - providerStartedAtMs
                  };
                }
                const observation = outputGuard.observe(event.text);
                stdout = observation.state === "tripped" ? observation.safeText : observation.text;
                if (observation.state !== "healthy" && !anomalyWarningSent) {
                  anomalyWarningSent = true;
                  void this.notifyRuntimeEvent({
                    job: { ...job },
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
                  abortController.abort(new Error("Recognition output anomaly"));
                }
              }
              void this.notifyRuntimeEvent({
                job,
                level: eventLevel(event),
                message: message ?? "",
                transcriptBlockId: transcriptBlock?.id,
                previewChanged: false
              });
              if (transcriptBlock) {
                updateDraft(buildRecognitionDraftMarkdown(runtimeLines, stdout, providerLabel), event);
              }
            }
          })
        : await this.deps.provider.transcribe(transcribeInput);
      if (outputAnomaly) {
        throw new Error("Recognition output anomaly");
      }
      await flushPendingDraft();

      const block: BlockRef =
        transcriptBlock ??
        (await this.deps.writer.writeAiTranscript({
          notebookId: job.notebookId,
          sessionId: job.sessionId,
          markdown: transcript.markdown,
          fromAssets: [job.assetPath],
          insertAfterBlockId: job.imageBlockId,
          now: job.now
        }));

      if (transcriptBlock) {
        await this.deps.writer.updateAiTranscript({
          notebookId: job.notebookId,
          sessionId: job.sessionId,
          blockId: transcriptBlock.id,
          markdown: transcript.markdown,
          now: new Date().toISOString()
        });
        await this.notifyRuntimeEvent({
          job: { ...job, transcriptBlockId: transcriptBlock.id },
          level: "info",
          message: "最终 Markdown 已写入草稿块。",
          transcriptBlockId: transcriptBlock.id,
          previewChanged: true
        });
      }

      await this.notifyRuntimeEvent({
        job: { ...job, transcriptBlockId: block.id },
        level: "info",
        message: `识别服务已完成：${providerLabel}。`,
        transcriptBlockId: block.id,
        previewChanged: true
      });

      job.status = "succeeded";
      job.failureKind = undefined;
      job.transcriptBlockId = block.id;
      job.warnings = mergeWarnings(transcript.warnings, validateFaithfulTranscriptionOutput(transcript.markdown));
      finishRecognitionTiming(job);
      await this.notifyJobChanged(job);
    } catch (error) {
      if (draftUpdateTimer) {
        clearTimeout(draftUpdateTimer);
        draftUpdateTimer = undefined;
      }
      pendingDraft = undefined;
      await updateChain.catch(() => undefined);
      const cancelled = !outputAnomaly && (abortController.signal.aborted || isRecognitionCancellation(error));
      job.status = cancelled ? "cancelled" : "failed";
      job.failureKind = outputAnomaly ? "output_anomaly" : undefined;
      job.error = outputAnomaly
        ? `异常输出已停止：${outputAnomaly.detail}`
        : cancelled
          ? "用户已中断识别。"
          : error instanceof Error
            ? error.message
            : "unknown error";
      finishRecognitionTiming(job);
      if (transcriptBlock) {
        await this.deps.writer.updateAiTranscript({
          notebookId: job.notebookId,
          sessionId: job.sessionId,
          blockId: transcriptBlock.id,
          markdown: outputAnomaly
            ? buildRecognitionAnomalyMarkdown(outputAnomaly.safeText, providerLabel, outputAnomaly.detail)
            : cancelled
              ? buildRecognitionCancelledMarkdown(providerLabel)
              : buildRecognitionFailureMarkdown(job.error, providerLabel),
          now: new Date().toISOString()
        });
      }
      await this.notifyRuntimeEvent({
        job: { ...job, transcriptBlockId: transcriptBlock?.id ?? job.transcriptBlockId },
        level: outputAnomaly ? "warning" : cancelled ? "info" : "error",
        message: outputAnomaly
          ? `异常输出已自动停止（${providerLabel}）：${outputAnomaly.detail}`
          : cancelled
            ? `识别已中断：${providerLabel}。`
            : `识别服务失败（${providerLabel}）：${job.error}`,
        transcriptBlockId: transcriptBlock?.id ?? job.transcriptBlockId,
        previewChanged: Boolean(transcriptBlock)
      });
      await this.notifyJobChanged(job);
    } finally {
      this.abortControllers.delete(job.id);
    }

    return { ...job };
  }

  private async notifyJobChanged(job: RecognitionJob): Promise<void> {
    await this.deps.onJobChanged?.({ ...job });
  }

  private async notifyRuntimeEvent(event: RecognitionRuntimeEvent): Promise<void> {
    await this.deps.onRuntimeEvent?.(event);
  }

  private createJob(args: EnqueueRecognitionJobArgs): RecognitionJob {
    return {
      id: args.jobId ?? `recognition_${args.imageBlockId}`,
      notebookId: args.notebookId,
      sessionId: args.sessionId,
      imageBlockId: args.imageBlockId,
      assetPath: args.assetPath,
      imagePath: args.imagePath,
      now: args.now,
      status: "pending",
      attempts: 0,
      maxAttempts: this.deps.maxAttempts ?? 2,
      providerName: this.deps.provider.name,
      providerLabel: recognitionProviderLabel(this.deps.provider.name),
      transcriptBlockId: args.transcriptBlockId,
      batchId: args.batchId,
      pageNumber: args.pageNumber,
      pageCount: args.pageCount,
      timing: {
        acceptedAt: args.now
      }
    };
  }
}

function finishRecognitionTiming(job: RecognitionJob): void {
  const completedAtMs = Date.now();
  const acceptedAt = job.timing?.acceptedAt ?? job.now;
  const providerStartedAt = job.timing?.providerStartedAt;
  job.timing = {
    acceptedAt,
    ...job.timing,
    completedAt: new Date(completedAtMs).toISOString(),
    providerMs: providerStartedAt ? elapsedFromIso(providerStartedAt, completedAtMs) : undefined,
    totalMs: elapsedFromIso(acceptedAt, completedAtMs)
  };
}

function elapsedFromIso(startedAt: string, completedAtMs: number): number | undefined {
  const startedAtMs = Date.parse(startedAt);
  return Number.isFinite(startedAtMs) ? Math.max(0, completedAtMs - startedAtMs) : undefined;
}

export function eventLevel(event?: RecognitionProviderEvent): RecognitionRuntimeEvent["level"] {
  if (!event) return "info";
  if (event.type === "stdout") return "stdout";
  if (event.type === "stderr") return "stderr";
  return "info";
}

export function eventMessage(event?: RecognitionProviderEvent): string | undefined {
  if (!event) return undefined;
  if (event.type === "stdout" || event.type === "stderr") return event.text;
  return event.message;
}

export function buildRecognitionDraftMarkdown(runtimeLines: string[], stdout: string, providerLabel = "识别服务"): string {
  const markdown = stdout.trim();
  if (markdown) {
    return markdown;
  }

  return [
    `#### 正在识别（${providerLabel}）`,
    "",
    "```text",
    ...runtimeLines.map((line) => line.trim()).filter(Boolean).slice(-20),
    "```"
  ].join("\n");
}

export function buildRecognitionFailureMarkdown(error: string, providerLabel = "识别服务"): string {
  return [`#### 识别失败（${providerLabel}）`, "", error, "", "网络恢复后，请在任务面板点击重试。"].join("\n");
}

export function buildRecognitionCancelledMarkdown(providerLabel = "识别服务"): string {
  return [`#### 识别已中断（${providerLabel}）`, "", "用户已中断当前识别。可以稍后在任务面板重新识别。"].join("\n");
}

export function buildRecognitionAnomalyMarkdown(
  safeText: string,
  providerLabel = "识别服务",
  detail = "检测到持续异常输出。"
): string {
  const diagnostic = [
    `#### 异常输出已停止（${providerLabel}）`,
    "",
    detail,
    "",
    "已丢弃异常重复尾部。可以在任务面板重试。"
  ].join("\n");
  const preserved = safeText.trim();
  return preserved ? `${preserved}\n\n---\n\n${diagnostic}` : diagnostic;
}

function transcriptBlockFromJob(job: RecognitionJob): BlockRef | undefined {
  if (!job.transcriptBlockId) {
    return undefined;
  }

  return {
    id: job.transcriptBlockId,
    type: "markdown",
    path: `blocks/${job.transcriptBlockId}_ai_transcript.md`,
    source: "ai_transcription",
    status: "draft",
    readonly: false,
    editableByAi: true,
    fromAssets: [job.assetPath],
    createdAt: job.now,
    updatedAt: job.now
  };
}

function mergeWarnings(...groups: Array<string[] | undefined>): string[] | undefined {
  const warnings = groups.flatMap((group) => group ?? []);
  if (warnings.length === 0) {
    return undefined;
  }

  return [...new Set(warnings)];
}

export function recognitionProviderLabel(providerName: string): string {
  if (isRecognitionProviderId(providerName)) {
    return getRecognitionProviderCapability(providerName).label;
  }
  if (providerName === "codex_app_server") {
    return "Codex 订阅识别";
  }
  return providerName;
}

function isRecognitionProviderId(providerName: string): providerName is RecognitionProviderId {
  return (
    providerName === "mock" ||
    providerName === "openai_vision" ||
    providerName === "glm_5_2" ||
    providerName === "mimo_2_5" ||
    providerName === "deepseek" ||
    providerName === "codex_cli"
  );
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
