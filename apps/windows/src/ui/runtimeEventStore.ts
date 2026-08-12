import { useSyncExternalStore } from "react";
import type { RecognitionRuntimeEvent } from "../types/mathNotesApi";

const maxRuntimeEvents = 500;
const runtimeEventFlushDelayMs = 48;
const emptyRuntimeEvents: RecognitionRuntimeEvent[] = [];

let runtimeEvents: RecognitionRuntimeEvent[] = [];
let pendingRuntimeEvents: RecognitionRuntimeEvent[] = [];
let runtimeEventFlushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) listener();
}

export function flushRecognitionRuntimeEvents() {
  runtimeEventFlushTimer = null;
  if (pendingRuntimeEvents.length === 0) return;

  const pending = pendingRuntimeEvents;
  pendingRuntimeEvents = [];
  runtimeEvents = [...pending.reverse(), ...runtimeEvents].slice(0, maxRuntimeEvents);
  emitChange();
}

export function appendRecognitionRuntimeEvent(event: RecognitionRuntimeEvent) {
  pendingRuntimeEvents.push(event);
  if (runtimeEventFlushTimer === null) {
    runtimeEventFlushTimer = globalThis.setTimeout(flushRecognitionRuntimeEvents, runtimeEventFlushDelayMs);
  }
}

export function clearRecognitionRuntimeEvents() {
  if (runtimeEventFlushTimer !== null) {
    globalThis.clearTimeout(runtimeEventFlushTimer);
    runtimeEventFlushTimer = null;
  }
  pendingRuntimeEvents = [];
  if (runtimeEvents.length === 0) return;
  runtimeEvents = [];
  emitChange();
}

export function getRecognitionRuntimeEvents() {
  return runtimeEvents;
}

export function subscribeRecognitionRuntimeEvents(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function subscribeToNoRuntimeEvents() {
  return () => undefined;
}

function getNoRuntimeEvents() {
  return emptyRuntimeEvents;
}

export function useRecognitionRuntimeEvents(enabled = true) {
  return useSyncExternalStore(
    enabled ? subscribeRecognitionRuntimeEvents : subscribeToNoRuntimeEvents,
    enabled ? getRecognitionRuntimeEvents : getNoRuntimeEvents,
    enabled ? getRecognitionRuntimeEvents : getNoRuntimeEvents
  );
}
