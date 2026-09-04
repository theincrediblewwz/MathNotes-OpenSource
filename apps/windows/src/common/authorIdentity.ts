export const MATHNOTES_AUTHOR_ID = "WWZ SYSU";
export const MATHNOTES_AUTHOR_GITHUB_URL = "https://github.com/theincrediblewwz";
export const MATHNOTES_AUTHOR_GITHUB_LABEL = "github.com/theincrediblewwz";

export function isMathNotesAuthorGithubUrl(candidateUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    return candidate.protocol === "https:"
      && candidate.hostname === "github.com"
      && candidate.port === ""
      && candidate.username === ""
      && candidate.password === ""
      && (candidate.pathname === "/theincrediblewwz" || candidate.pathname === "/theincrediblewwz/")
      && candidate.search === ""
      && candidate.hash === "";
  } catch {
    return false;
  }
}
