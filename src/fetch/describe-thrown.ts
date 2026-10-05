/**
 * Describe a caught value for a warning or error message without throwing.
 *
 * `String(value)` throws for an object with no prototype or a `toString` that
 * throws, and a catch that formats with it would then throw from inside its own
 * catch. This falls back to the `[object Tag]` form, then to a fixed phrase.
 */
export function describeThrown(value: unknown): string {
  try {
    return value instanceof Error ? value.message : String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "a thrown value that cannot be printed";
    }
  }
}
