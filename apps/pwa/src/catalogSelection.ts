import type { PairingTarget } from "./domain";

export function sameTarget(left: PairingTarget, right: PairingTarget): boolean {
  return left.notebookId === right.notebookId && left.sessionId === right.sessionId;
}

export function retainAvailableSelection(
  current: PairingTarget | undefined,
  targets: readonly PairingTarget[]
): PairingTarget | undefined {
  if (!current) return undefined;
  return targets.find((target) => sameTarget(target, current));
}
