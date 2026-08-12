import { describe, expect, it, vi } from "vitest";
import { createClientId } from "./clientId";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createClientId", () => {
  it("uses native randomUUID when the browser provides it", () => {
    const randomUUID = vi.fn(() => "12345678-1234-4123-8123-123456789abc");
    expect(createClientId("manual", { randomUUID })).toBe(
      "manual-12345678-1234-4123-8123-123456789abc"
    );
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("uses getRandomValues when randomUUID is missing", () => {
    const getRandomValues = vi.fn(<T extends ArrayBufferView>(array: T): T => {
      if (array instanceof Uint8Array) {
        array.forEach((_, index) => {
          array[index] = index;
        });
      }
      return array;
    });
    const id = createClientId(undefined, { getRandomValues });
    expect(id).toMatch(UUID_V4);
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("keeps non-secret IDs unique when Web Crypto is unavailable", () => {
    const first = createClientId("upload", undefined);
    const second = createClientId("upload", undefined);
    expect(first).not.toBe(second);
    expect(first.slice("upload-".length)).toMatch(UUID_V4);
    expect(second.slice("upload-".length)).toMatch(UUID_V4);
  });
});
