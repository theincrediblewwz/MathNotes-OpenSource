export type RecognitionTimelineStage =
  | "runtime-event-received"
  | "refresh-scheduled"
  | "refresh-coalesced"
  | "refresh-timer-fired"
  | "session-load-start"
  | "session-load-end"
  | "document-apply-start"
  | "document-apply-end"
  | "react-layout-commit"
  | "next-paint";

export type RecognitionTimelineEntry = {
  traceId: string;
  stage: RecognitionTimelineStage;
  at: number;
};

type RecognitionTimelineLabApi = {
  record: (entry: RecognitionTimelineEntry) => void;
};

declare global {
  interface Window {
    __mathNotesRecognitionTimelineLab?: RecognitionTimelineLabApi;
  }
}

export function recordRecognitionTimeline(traceId: string | undefined, stage: RecognitionTimelineStage): void {
  if (!traceId) return;
  window.__mathNotesRecognitionTimelineLab?.record({
    traceId,
    stage,
    at: performance.now()
  });
}
