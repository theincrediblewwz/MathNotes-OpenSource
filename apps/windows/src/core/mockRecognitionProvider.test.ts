import { describe, expect, it } from "vitest";
import { MockRecognitionProvider } from "./mockRecognitionProvider";

describe("MockRecognitionProvider", () => {
  it("returns deterministic placeholder markdown without duplicating source headers", async () => {
    const provider = new MockRecognitionProvider();

    const result = await provider.transcribe({
      imagePaths: ["assets/photos/photo_001.jpg"],
      mode: "faithful",
      outputFormat: "markdown",
      sessionId: "lecture_03"
    });

    expect(result.markdown).not.toContain("source: photo_001.jpg");
    expect(result.markdown).toContain("#### Mock 识别占位");
    expect(result.markdown).toContain("当前任务使用的是 mock provider");
    expect(result.markdown).not.toContain("\\documentclass");
    expect(result.warnings).toEqual(["mock_provider_used"]);
  });
});
