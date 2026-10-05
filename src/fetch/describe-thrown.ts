/**
 * Describe a caught value for a warning or error message without throwing.
 *
 * `String(value)` throws for an object with no prototype or a `toString` that
 * throws, and a catch that formats with it would then throw from inside its own
 * catch. This falls back to the `[object Tag]` form, then to a fixed phrase
 * (for a value even that throws on, such as a revoked Proxy).
 */
export function describeThrown(value: unknown): string {
  try {
    // An Error's `message` can be any value (a Symbol, an object), so it is
    // converted here too rather than in the caller's template literal.
    return String(value instanceof Error ? value.message : value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "a thrown value that cannot be printed";
    }
  }
}
