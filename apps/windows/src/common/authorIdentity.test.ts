import { describe, expect, it } from "vitest";
import { isMathNotesAuthorGithubUrl, MATHNOTES_AUTHOR_GITHUB_URL } from "./authorIdentity";

describe("MathNotes author identity", () => {
  it("allows only the exact HTTPS author profile", () => {
    expect(isMathNotesAuthorGithubUrl(MATHNOTES_AUTHOR_GITHUB_URL)).toBe(true);
    expect(isMathNotesAuthorGithubUrl(`${MATHNOTES_AUTHOR_GITHUB_URL}/`)).toBe(true);
    expect(isMathNotesAuthorGithubUrl("http://github.com/theincrediblewwz")).toBe(false);
    expect(isMathNotesAuthorGithubUrl("https://github.com/theincrediblewwz/MathNotes")).toBe(false);
    expect(isMathNotesAuthorGithubUrl("https://github.com/theincrediblewwz?tab=repositories")).toBe(false);
    expect(isMathNotesAuthorGithubUrl("https://github.com.evil.example/theincrediblewwz")).toBe(false);
  });
});
