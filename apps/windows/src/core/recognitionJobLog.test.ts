import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecognitionJob } from "./recognitionQueue";
import { recognitionJobToTaskSummary, readRecognitionJobs, upsertRecognitionJob } from "./recognitionJobLog";

describe("RecognitionJobLog", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-recognition-jobs-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("returns an empty list when the job log is missing", async () => {
    await expect(
      readRecognitionJobs({
        rootDir,
        notebookId: "functional_analysis",
        sessionId: "lecture"
      })
    ).resolves.toEqual([]);
  });

  it("upserts failed jobs into recognition_jobs.json", async () => {
    await upsertRecognitionJob({
      rootDir,
      job: failedJob({ error: "provider offline" })
    });

    const jobs = await readRecognitionJobs({
      rootDir,
      notebookId: "functional_analysis",
      sessionId: "lecture"
    });
    expect(jobs).toEqual([failedJob({ error: "provider offline" })]);

    const raw = JSON.parse(
      await readFile(
        join(rootDir, "notebooks/functional_analysis/sessions/lecture/logs/recognition_jobs.json"),
        "utf8"
      )
    );
    expect(raw[0]).toMatchObject({
      id: "recognition_0001",
      status: "failed",
      error: "provider offline"
    });
  });

  it("replaces existing jobs with the same id", async () => {
    await upsertRecognitionJob({
      rootDir,
      job: failedJob({ error: "provider offline" })
    });
    await upsertRecognitionJob({
      rootDir,
      job: {
        ...failedJob({ error: "provider offline" }),
        status: "succeeded",
        transcriptBlockId: "0002",
        error: undefined,
        warnings: ["mock_provider_used"]
      }
    });

    await expect(
      readRecognitionJobs({
        rootDir,
        notebookId: "functional_analysis",
        sessionId: "lecture"
      })
    ).resolves.toEqual([
      {
        ...failedJob({ error: "provider offline" }),
        status: "succeeded",
        transcriptBlockId: "0002",
        error: undefined,
        warnings: ["mock_provider_used"]
      }
    ]);
  });

  it("recovers persisted running jobs as failed after app restart", async () => {
    await upsertRecognitionJob({
      rootDir,
      job: {
        ...failedJob(),
        status: "running",
        attempts: 1,
        error: undefined,
        transcriptBlockId: "0002"
      }
    });

    await expect(
      readRecognitionJobs({
        rootDir,
        notebookId: "functional_analysis",
        sessionId: "lecture"
      })
    ).resolves.toEqual([
      {
        ...failedJob(),
        status: "failed",
        attempts: 1,
        transcriptBlockId: "0002",
        error: "上次识别运行被中断，请在网络恢复后手动重试。"
      }
    ]);
  });

  it("keeps freshly upserted running jobs in the raw job log", async () => {
    await upsertRecognitionJob({
      rootDir,
      job: {
        ...failedJob(),
        status: "running",
        attempts: 1,
        error: undefined
      }
    });

    const raw = JSON.parse(
      await readFile(
        join(rootDir, "notebooks/functional_analysis/sessions/lecture/logs/recognition_jobs.json"),
        "utf8"
      )
    );
    expect(raw[0]).toMatchObject({
      id: "recognition_0001",
      status: "running"
    });
    expect(raw[0]).not.toHaveProperty("error");
  });

  it("maps failed jobs to recognition task summaries", () => {
    expect(recognitionJobToTaskSummary(failedJob({ error: "provider offline" }))).toEqual({
      id: "recognition_0001",
      fileName: "photo_001.jpg",
      assetPath: "assets/photos/photo_001.jpg",
      recognitionJobId: "recognition_0001",
      recognitionStatus: "failed",
      imageBlockId: "0001",
      transcriptBlockId: "-",
      receivedAt: "2026-06-27T01:00:00.000Z",
      providerName: undefined,
      providerLabel: undefined,
      error: "provider offline"
    });
  });

  it("preserves provider identity in persisted jobs and task summaries", async () => {
    await upsertRecognitionJob({
      rootDir,
      job: failedJob({
        providerName: "mimo_2_5",
        providerLabel: "Mimo v2.5",
        error: "looping output interrupted"
      })
    });

    const jobs = await readRecognitionJobs({
      rootDir,
      notebookId: "functional_analysis",
      sessionId: "lecture"
    });

    expect(jobs[0]).toMatchObject({
      providerName: "mimo_2_5",
      providerLabel: "Mimo v2.5"
    });
    expect(recognitionJobToTaskSummary(jobs[0])).toMatchObject({
      providerName: "mimo_2_5",
      providerLabel: "Mimo v2.5"
    });
  });

  it("preserves output anomaly failure kinds in persisted jobs and task summaries", async () => {
    await upsertRecognitionJob({
      rootDir,
      job: failedJob({
        failureKind: "output_anomaly",
        error: "异常输出已停止"
      })
    });

    const [job] = await readRecognitionJobs({
      rootDir,
      notebookId: "functional_analysis",
      sessionId: "lecture"
    });

    expect(job).toMatchObject({
      status: "failed",
      failureKind: "output_anomaly"
    });
    expect(recognitionJobToTaskSummary(job)).toMatchObject({
      recognitionStatus: "failed",
      failureKind: "output_anomaly"
    });
  });
});

function failedJob(overrides: Partial<RecognitionJob> = {}): RecognitionJob {
  return {
    id: "recognition_0001",
    notebookId: "functional_analysis",
    sessionId: "lecture",
    imageBlockId: "0001",
    assetPath: "assets/photos/photo_001.jpg",
    imagePath: "C:/tmp/photo_001.jpg",
    now: "2026-06-27T01:00:00.000Z",
    status: "failed",
    attempts: 1,
    maxAttempts: 2,
    ...overrides
  };
}
