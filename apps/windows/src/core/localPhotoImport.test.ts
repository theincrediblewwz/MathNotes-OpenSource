import { describe, expect, it } from "vitest";
import { detectLocalPhotoMimeType } from "./localPhotoImport";

describe("detectLocalPhotoMimeType", () => {
  it.each([
    ["blackboard.jpg", "image/jpeg"],
    ["blackboard.JPEG", "image/jpeg"],
    ["page.png", "image/png"],
    ["draft.WEBP", "image/webp"]
  ])("detects %s as %s", (fileName, expected) => {
    expect(detectLocalPhotoMimeType(fileName)).toBe(expected);
  });

  it("rejects unsupported local photo extensions", () => {
    expect(() => detectLocalPhotoMimeType("notes.pdf")).toThrow("Unsupported local photo type: notes.pdf");
  });
});
