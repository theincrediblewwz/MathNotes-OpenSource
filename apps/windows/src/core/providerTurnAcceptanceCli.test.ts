import { describe, expect, it } from "vitest";
import { parseProviderTurnAcceptanceArgs } from "../../../../test_tool/provider_turn_acceptance";

describe("parseProviderTurnAcceptanceArgs", () => {
  it("parses an explicit image and optional acceptance paths", () => {
    expect(
      parseProviderTurnAcceptanceArgs([
        "--image",
        "C:/photos/board.png",
        "--notes-root",
        "C:/MathNotes",
        "--output-root",
        "C:/acceptance",
        "--allow-mock"
      ])
    ).toEqual({
      imagePath: "C:/photos/board.png",
      notesRoot: "C:/MathNotes",
      outputRoot: "C:/acceptance",
      allowMock: true
    });
  });

  it("rejects invocations without an explicit image", () => {
    expect(() => parseProviderTurnAcceptanceArgs(["--allow-mock"])).toThrow("--image");
  });
});
