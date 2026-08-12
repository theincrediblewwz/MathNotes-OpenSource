export function createSessionId(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace("T", "_").replaceAll(":", "");
  return `${stamp}_session`;
}

export function createSessionTitle(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  return `数学笔记 ${stamp}`;
}
