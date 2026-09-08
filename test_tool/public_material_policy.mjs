// Internal collaboration documents are not release payloads, even when tracked
// under an otherwise public source directory. Product/API documentation remains public.
export function isInternalPublicationPath(value) {
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.some(part => /^(?:AGENTS|CLAUDE|NOW|HANDOFF|MEMORY|TODO)\.md$/i.test(part)
    || /(?:handoff|交接)/i.test(part)
    || /(?:^|[_-])codex(?:[_-].*)?\.md$/i.test(part));
}

export function assertPublicMaterial(name, bytes) {
  if (isInternalPublicationPath(name)) throw new Error(`Internal collaboration material is not public: ${name}`);
  if (!/\.md$/i.test(name)) return;
  const contents = Buffer.from(bytes).toString("utf8");
  if (/^#{1,6}\s.*(?:Codex\s*接手|给\s*(?:Mac\s*)?Codex|内部交接|Agent\s*交接)/im.test(contents)
      || /用户有\s*Windows\s*和\s*Mac\s*两台电脑|用户交接的公开上游|请\s*Mac\s*Codex\s*在|Mac\s*上正在进行的任务/.test(contents)) {
    throw new Error(`Internal collaboration instructions in public document: ${name}`);
  }
}
