import { createHash } from "node:crypto";
import { compareCodeUnits } from "./canonical-json.js";
import { prepareContent } from "./content-prep.js";
import type { ExtractionExample, ExtractionTaskSpec, TargetFieldSchema } from "./types.js";

type ExampleDraft = Omit<ExtractionExample, "digest">;
type TaskDraft = Omit<ExtractionTaskSpec, "digest" | "examples"> & { examples?: ExampleDraft[] };

type KeyOrder = (a: string, b: string) => number;

function canonicalWith(value: unknown, order: KeyOrder): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalWith(item, order)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => order(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalWith(item, order)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Canonical JSON text for task-spec digests. Keys sort in UTF-16 code-unit
 * order, the same order as the portable envelope, so a digest is a pure
 * function of the payload on every host.
 */
export function canonicalTaskJson(value: unknown): string {
  return canonicalWith(value, compareCodeUnits);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalTaskJson(value)).digest("hex")}`;
}

/**
 * Digests written before key order was locale-independent sorted keys with
 * `localeCompare` under the host's default ICU locale. Accepting that form on
 * validation keeps every spec that validated on this host before the change
 * working; it cannot repair a spec created under a different locale.
 * Remove in the next major version.
 */
function legacyLocaleDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalWith(value, (a, b) => a.localeCompare(b))).digest("hex")}`;
}

/** "current" for a code-unit digest, "legacy" for a legacy locale digest, undefined for neither. */
function digestForm(expected: string, value: unknown): "current" | "legacy" | undefined {
  if (expected === digest(value)) return "current";
  if (expected === legacyLocaleDigest(value)) return "legacy";
  return undefined;
}

function examplePayload(example: ExtractionExample | ExampleDraft): ExampleDraft {
  const { content, contentType, proposals } = example;
  return { content, ...(contentType ? { contentType } : {}), proposals };
}

function taskPayload(task: ExtractionTaskSpec): Omit<ExtractionTaskSpec, "digest"> {
  const { version, targetSchema, guidance, examples } = task;
  return { version, targetSchema, ...(guidance !== undefined ? { guidance } : {}), ...(examples ? { examples } : {}) };
}

/** Construct a task with deterministic example and task digests. */
export function createExtractionTaskSpec(input: TaskDraft): ExtractionTaskSpec {
  const examples = input.examples?.map((example) => ({ ...examplePayload(example), digest: digest(examplePayload(example)) }));
  const payload = {
    version: input.version,
    targetSchema: input.targetSchema,
    ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
    ...(examples ? { examples } : {}),
  };
  return { ...payload, digest: digest(payload) };
}

/** Whether a value has the JSON type (and, for an enum, a member) the field declares. */
export function valueMatches(value: unknown, field: TargetFieldSchema): boolean {
  switch (field.type) {
    case "string": case "date": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "enum": return typeof value === "string" && !!field.enumValues?.includes(value);
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
  }
}

export interface ExtractionTaskSpecCheck {
  error?: string;
  /** Digest locations (`taskSpec.digest`, `taskSpec.examples[i].digest`) that matched only the legacy locale-dependent form. */
  legacyDigests: string[];
}

/** Validate a task spec and report which digests use the legacy locale-dependent form. */
export function checkExtractionTaskSpec(task: ExtractionTaskSpec, targetSchema: TargetFieldSchema[]): ExtractionTaskSpecCheck {
  const legacyDigests: string[] = [];
  const fail = (error: string): ExtractionTaskSpecCheck => ({ error, legacyDigests });
  if (!task.version.trim()) return fail("taskSpec.version must be non-empty");
  if (canonicalTaskJson(task.targetSchema) !== canonicalTaskJson(targetSchema)) return fail("taskSpec.targetSchema must exactly match targetSchema");
  const taskForm = digestForm(task.digest, taskPayload(task));
  if (!taskForm) return fail("taskSpec.digest does not match its canonical payload");
  if (taskForm === "legacy") legacyDigests.push("taskSpec.digest");
  const fields = new Map(targetSchema.map((field) => [field.path, field]));
  for (const [index, example] of (task.examples ?? []).entries()) {
    const exampleForm = digestForm(example.digest, examplePayload(example));
    if (!exampleForm) return fail(`taskSpec.examples[${index}].digest does not match its canonical payload`);
    if (exampleForm === "legacy") legacyDigests.push(`taskSpec.examples[${index}].digest`);
    const prepared = prepareContent(example.content, example.contentType ?? "text");
    if (prepared.error) return fail(`taskSpec.examples[${index}] content is invalid: ${prepared.error}`);
    const preparedText = prepared.text ?? "";
    for (const [proposalIndex, proposal] of example.proposals.entries()) {
      const field = fields.get(proposal.fieldPath);
      if (!field) return fail(`taskSpec.examples[${index}].proposals[${proposalIndex}] references unknown fieldPath "${proposal.fieldPath}"`);
      if (!valueMatches(proposal.candidateValue, field)) return fail(`taskSpec.examples[${index}].proposals[${proposalIndex}] candidateValue does not match ${field.type}`);
      if (!proposal.excerpt || !preparedText.includes(proposal.excerpt)) return fail(`taskSpec.examples[${index}].proposals[${proposalIndex}] excerpt is not grounded in prepared example content`);
    }
  }
  return { legacyDigests };
}

/**
 * Return a precise validation error, or undefined for a usable task. A digest
 * in the legacy locale-dependent form is still accepted (see
 * `checkExtractionTaskSpec`, which reports it).
 */
export function validateExtractionTaskSpec(task: ExtractionTaskSpec, targetSchema: TargetFieldSchema[]): string | undefined {
  return checkExtractionTaskSpec(task, targetSchema).error;
}
