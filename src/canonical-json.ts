/**
 * Canonical key order shared by task-spec digests and the portable envelope:
 * UTF-16 code-unit order (RFC 8785), which is independent of the host locale.
 * `String.prototype.localeCompare` must not be used here — its result depends
 * on the process's ICU default locale.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
