import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecognitionRuntimeEvent } from "../types/mathNotesApi";
import {
  appendRecognitionRuntimeEvent,
  clearRecognitionRuntimeEvents,
  getRecognitionRuntimeEvents,
  subscribeRecognitionRuntimeEvents
} from "./runtimeEventStore";

function runtimeEvent(index: number): RecognitionRuntimeEvent {
  return {
    id: `event-${index}`,
    recognitionJobId: "recognition_0001",
    notebookId: "functional_analysis",
    sessionId: "lecture",
    level: "stdout",
    message: `chunk-${index}`,
    at: `2026-07-18T12:00:${String(index % 60).padStart(2, "0")}.000Z`
  };
}

describe("runtimeEventStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearRecognitionRuntimeEvents();
  });

  afterEach(() => {
    clearRecognitionRuntimeEvents();
    vi.useRealTimers();
  });

  it("batches events for 48ms and publishes newest events first", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRecognitionRuntimeEvents(listener);

    appendRecognitionRuntimeEvent(runtimeEvent(1));
    appendRecognitionRuntimeEvent(runtimeEvent(2));
    expect(getRecognitionRuntimeEvents()).toEqual([]);

    vi.advanceTimersByTime(48);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getRecognitionRuntimeEvents().map((event) => event.id)).toEqual(["event-2", "event-1"]);
    unsubscribe();
  });

  it("retains only the newest 500 events", () => {
    for (let index = 0; index < 520; index += 1) appendRecognitionRuntimeEvent(runtimeEvent(index));
    vi.advanceTimersByTime(48);

    expect(getRecognitionRuntimeEvents()).toHaveLength(500);
    expect(getRecognitionRuntimeEvents()[0]?.id).toBe("event-519");
    expect(getRecognitionRuntimeEvents().at(-1)?.id).toBe("event-20");
  });

  it("cancels a pending batch when events are cleared", () => {
    appendRecognitionRuntimeEvent(runtimeEvent(1));
    clearRecognitionRuntimeEvents();
    vi.advanceTimersByTime(48);
    expect(getRecognitionRuntimeEvents()).toEqual([]);
  });
});
