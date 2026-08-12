import { isAbsolute } from "node:path";

const MAX_WORKSPACE_IDENTIFIER_LENGTH = 128;
const UNSAFE_WORKSPACE_IDENTIFIER_CHARACTER = /[\\/\u0000-\u001F\u007F]/u;

export function isSafeWorkspaceIdentifier(value: string | null | undefined): value is string {
  return Boolean(
    value &&
    value.length <= MAX_WORKSPACE_IDENTIFIER_LENGTH &&
    value !== "." &&
    value !== ".." &&
    !isAbsolute(value) &&
    !UNSAFE_WORKSPACE_IDENTIFIER_CHARACTER.test(value)
  );
}

export function assertSafeWorkspaceIdentifier(value: string): void {
  if (!isSafeWorkspaceIdentifier(value)) throw new Error("invalid_target");
}
