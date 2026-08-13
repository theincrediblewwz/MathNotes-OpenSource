export const DEFAULT_PREVIEW_FOLLOW_SHORTCUT = "Alt+T";

export type KeyboardEventLike = {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
};

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

const MODIFIER_ALIASES: Record<string, string> = {
  control: "Ctrl",
  ctrl: "Ctrl",
  ctl: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  win: "Meta",
  windows: "Meta",
  os: "Meta"
};

const MODIFIER_KEY_NAMES = new Set(["CONTROL", "ALT", "SHIFT", "META", "OS", "ALTGRAPH"]);

const FUNCTION_KEY_NAMES = new Set(Array.from({ length: 12 }, (_, index) => `F${index + 1}`));

export function normalizeKeyboardShortcut(input: string): string | null {
  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  const modifiers = new Set<string>();
  let keyPart: string | null = null;
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    if (keyPart !== null) {
      return null;
    }
    keyPart = normalizeKeyName(part);
    if (keyPart === null) {
      return null;
    }
  }

  if (!keyPart || MODIFIER_KEY_NAMES.has(keyPart) || keyPart === "Escape") {
    return null;
  }

  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  if (orderedModifiers.length === 0 && !FUNCTION_KEY_NAMES.has(keyPart)) {
    return null;
  }
  return [...orderedModifiers, keyPart].join("+");
}

export function normalizeKeyboardShortcutFromEvent(event: KeyboardEventLike): string | null {
  const key = normalizeKeyName(event.key);
  if (!key || MODIFIER_KEY_NAMES.has(key) || key === "Escape") {
    return null;
  }

  const modifiers = pressedModifiers(event);
  if (modifiers.length === 0 && !FUNCTION_KEY_NAMES.has(key)) {
    return null;
  }
  return [...modifiers, key].join("+");
}

export function isValidKeyboardShortcut(input: string | KeyboardEventLike): boolean {
  return typeof input === "string"
    ? normalizeKeyboardShortcut(input) !== null
    : normalizeKeyboardShortcutFromEvent(input) !== null;
}

export function matchesKeyboardShortcut(shortcut: string, event: KeyboardEventLike): boolean {
  const expected = normalizeKeyboardShortcut(shortcut);
  if (expected === null) {
    return false;
  }
  return normalizeKeyboardShortcutFromEvent(event) === expected;
}

function pressedModifiers(event: KeyboardEventLike): string[] {
  const modifiers: string[] = [];
  if (event.ctrlKey) {
    modifiers.push("Ctrl");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }
  if (event.metaKey) {
    modifiers.push("Meta");
  }
  return modifiers;
}

function normalizeKeyName(key: string): string | null {
  if (key === " ") {
    return "Space";
  }
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length === 1) {
    if (/[a-z]/i.test(trimmed)) {
      return trimmed.toUpperCase();
    }
    if (trimmed === "+") {
      return "Plus";
    }
    const code = trimmed.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return null;
    }
    return trimmed;
  }

  const upper = trimmed.toUpperCase();
  if (upper === "ESC" || upper === "ESCAPE") {
    return "Escape";
  }
  if (upper === "SPACE" || upper === "SPACEBAR") {
    return "Space";
  }
  if (upper === "PLUS") {
    return "Plus";
  }
  if (upper === "UNIDENTIFIED" || upper === "DEAD") {
    return null;
  }
  if (/^F(?:[1-9]|1[0-2])$/.test(upper)) {
    return upper;
  }
  return upper;
}
