import type {
  ExtractInput,
  ExtractionProvider,
  ExtractionProviderCapability,
  ExtractionProviderCapabilities,
  ExtractionProviderFailure,
} from "./types.js";

export const EXTRACTION_CONFORMANCE_CAPABILITIES: ExtractionProviderCapabilities = {
  supported: ["structured-output", "exact-excerpts", "task-specifications", "usage", "warnings"],
};

export function unsupportedProviderCapability(input: ExtractInput): ExtractionProviderCapability | undefined {
  const declared = input.provider.capabilities;
  if (!declared) return undefined; // legacy injected providers retain behavior
  const required: ExtractionProviderCapability[] = ["structured-output", "exact-excerpts"];
  if (input.taskSpec) required.push("task-specifications");
  return required.find((capability) => !declared.supported.includes(capability));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/** Classify control-flow semantics without replacing the provider's diagnostic. */
export function normalizeProviderFailure(provider: ExtractionProvider, error: unknown): ExtractionProviderFailure {
  const native = record(error);
  const status = typeof native?.["status"] === "number" ? native["status"] as number
    : typeof native?.["statusCode"] === "number" ? native["statusCode"] as number : undefined;
  const code = typeof native?.["code"] === "string" ? (native["code"] as string).toLowerCase() : "";
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const timeout = code.includes("timeout") || lower.includes("timeout");
  let kind: ExtractionProviderFailure["kind"] = "unknown";
  if (status === 401 || status === 403 || code.includes("auth")) kind = "authentication";
  else if (status === 429 || code.includes("rate")) kind = "rate-limit";
  else if (timeout || status === 408) kind = "timeout";
  else if (code.includes("invalid_request")) kind = "invalid-request";
  else if (status !== undefined && status >= 400 && status < 500) kind = "invalid-request";
  else if ((status !== undefined && status >= 500) || code.includes("unavailable")) kind = "unavailable";
  return {
    provider: provider.name,
    kind,
    retryable: typeof native?.["retryable"] === "boolean"
      ? native["retryable"] as boolean
      : kind === "rate-limit" || kind === "timeout" || kind === "unavailable",
    message,
    native: error,
  };
}
