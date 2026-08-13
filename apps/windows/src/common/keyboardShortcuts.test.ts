import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREVIEW_FOLLOW_SHORTCUT,
  isValidKeyboardShortcut,
  matchesKeyboardShortcut,
  normalizeKeyboardShortcut,
  normalizeKeyboardShortcutFromEvent
} from "./keyboardShortcuts";

describe("keyboardShortcuts", () => {
  it("exports the frozen default Alt+T", () => {
    expect(DEFAULT_PREVIEW_FOLLOW_SHORTCUT).toBe("Alt+T");
  });

  it("normalizes modifier order to Ctrl+Alt+Shift+Meta+Key", () => {
    expect(normalizeKeyboardShortcut("meta+shift+ctrl+alt+t")).toBe("Ctrl+Alt+Shift+Meta+T");
    expect(normalizeKeyboardShortcutFromEvent({
      altKey: true,
      ctrlKey: true,
      key: "T",
      metaKey: true,
      shiftKey: true
    })).toBe("Ctrl+Alt+Shift+Meta+T");
  });

  it("accepts F1-F12 without modifiers", () => {
    for (let index = 1; index <= 12; index += 1) {
      const key = `F${index}`;
      expect(normalizeKeyboardShortcut(key.toLowerCase())).toBe(key);
      expect(normalizeKeyboardShortcutFromEvent({ key })).toBe(key);
    }
    expect(isValidKeyboardShortcut("F5")).toBe(true);
  });

  it("rejects modifiers-only, Escape, and bare printable keys", () => {
    expect(normalizeKeyboardShortcut("Ctrl+Alt+Shift+Meta")).toBeNull();
    expect(normalizeKeyboardShortcut("T")).toBeNull();
    expect(normalizeKeyboardShortcut("1")).toBeNull();
    expect(normalizeKeyboardShortcut(" ")).toBeNull();
    expect(normalizeKeyboardShortcut("Escape")).toBeNull();
    expect(normalizeKeyboardShortcut("Alt+Escape")).toBeNull();
    expect(normalizeKeyboardShortcut("Enter")).toBeNull();
    expect(isValidKeyboardShortcut({ altKey: true, key: "Alt" })).toBe(false);
    expect(isValidKeyboardShortcut({ key: " " })).toBe(false);
  });

  it("allows modified printable keys including space", () => {
    expect(normalizeKeyboardShortcut("alt+t")).toBe("Alt+T");
    expect(normalizeKeyboardShortcutFromEvent({ altKey: true, key: "t" })).toBe("Alt+T");
    expect(normalizeKeyboardShortcutFromEvent({ ctrlKey: true, key: " " })).toBe("Ctrl+Space");
    expect(normalizeKeyboardShortcutFromEvent({ ctrlKey: true, key: "+" })).toBe("Ctrl+Plus");
    expect(normalizeKeyboardShortcut("Ctrl+Plus")).toBe("Ctrl+Plus");
    expect(matchesKeyboardShortcut("Ctrl+Plus", { ctrlKey: true, key: "+" })).toBe(true);
  });

  it("rejects multiple keys and unknown key names", () => {
    expect(normalizeKeyboardShortcut("Alt+T+U")).toBeNull();
    expect(normalizeKeyboardShortcut("ctrl++")).toBeNull();
    expect(isValidKeyboardShortcut({ ctrlKey: true, key: "Unidentified" })).toBe(false);
  });

  it("matches the configured shortcut case-insensitively and exactly on modifiers", () => {
    expect(matchesKeyboardShortcut("Alt+T", { altKey: true, key: "t" })).toBe(true);
    expect(matchesKeyboardShortcut("Ctrl+Shift+F1", { ctrlKey: true, key: "f1", shiftKey: true })).toBe(true);
    expect(matchesKeyboardShortcut("Alt+T", { key: "t" })).toBe(false);
    expect(matchesKeyboardShortcut("Alt+T", { altKey: true, ctrlKey: true, key: "T" })).toBe(false);
    expect(matchesKeyboardShortcut("not-a-shortcut", { altKey: true, key: "T" })).toBe(false);
  });
});
