import type { MathNotesApi } from "./mathNotesApi";

declare global {
  interface Window {
    mathNotes?: MathNotesApi;
  }
}

export {};
