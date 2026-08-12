export const assistantDragMime = "application/x-mathnotes-assistant-context";

export type AssistantDragPayload = {
  kind: "selection" | "block";
  blockId: string;
  label: string;
  text?: string;
  from?: number;
  to?: number;
};

export function writeAssistantDragPayload(transfer: DataTransfer, payload: AssistantDragPayload): void {
  transfer.effectAllowed = "copy";
  transfer.setData(assistantDragMime, JSON.stringify(payload));
  transfer.setData("text/plain", payload.text || payload.label);
}

export function readAssistantDragPayload(transfer: DataTransfer): AssistantDragPayload | null {
  try {
    const parsed = JSON.parse(transfer.getData(assistantDragMime)) as Partial<AssistantDragPayload>;
    if ((parsed.kind !== "selection" && parsed.kind !== "block") || !parsed.blockId || !parsed.label) return null;
    return {
      kind: parsed.kind,
      blockId: parsed.blockId,
      label: parsed.label,
      text: parsed.text,
      from: Number.isInteger(parsed.from) ? parsed.from : undefined,
      to: Number.isInteger(parsed.to) ? parsed.to : undefined
    };
  } catch {
    return null;
  }
}
