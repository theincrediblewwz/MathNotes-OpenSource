type BrowserCrypto = Readonly<{
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}>;

let fallbackSequence = 0;

/**
 * Generates a non-secret browser-side identifier.
 *
 * Device authentication still comes from the host-issued token. This value only
 * correlates a browser profile or upload task, so older WebViews may safely fall
 * back when Web Crypto is incomplete.
 */
export function createClientId(prefix?: string, source: BrowserCrypto | undefined = globalThis.crypto): string {
  const uuid = createUuid(source);
  return prefix ? `${prefix}-${uuid}` : uuid;
}

function createUuid(source?: BrowserCrypto): string {
  if (typeof source?.randomUUID === "function") {
    try {
      return source.randomUUID();
    } catch {
      // Some embedded browsers expose the method but reject it outside their expected context.
    }
  }

  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === "function") {
    try {
      source.getRandomValues(bytes);
      return formatUuid(bytes);
    } catch {
      // Continue with the non-secret uniqueness fallback below.
    }
  }

  const sequence = ++fallbackSequence;
  let seed = (
    Date.now() ^
    sequence ^
    Math.floor(Math.random() * 0x7fffffff) ^
    Math.floor((globalThis.performance?.now?.() ?? 0) * 1_000)
  ) >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    seed = (Math.imul(seed ^ (seed >>> 15), 2_246_822_519) + 3_266_489_917) >>> 0;
    bytes[index] = (seed >>> ((index % 4) * 8)) & 0xff;
  }
  return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}
