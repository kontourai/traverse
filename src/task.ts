import { createHash } from "node:crypto";
import { prepareContent } from "./content-prep.js";
import type { ExtractionExample, ExtractionTaskSpec, TargetFieldSchema } from "./types.js";

type ExampleDraft = Omit<ExtractionExample, "digest">;
type TaskDraft = Omit<ExtractionTaskSpec, "digest" | "examples"> & { examples?: ExampleDraft[] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
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

function valueMatches(value: unknown, field: TargetFieldSchema): boolean {
  switch (field.type) {
    case "string": case "date": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "enum": return typeof value === "string" && !!field.enumValues?.includes(value);
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
  }
}

/** Return a precise validation error, or undefined for a usable task. */
export function validateExtractionTaskSpec(task: ExtractionTaskSpec, targetSchema: TargetFieldSchema[]): string | undefined {
  if (!task.version.trim()) return "taskSpec.version must be non-empty";
  if (canonical(task.targetSchema) !== canonical(targetSchema)) return "taskSpec.targetSchema must exactly match targetSchema";
  if (task.digest !== digest(taskPayload(task))) return "taskSpec.digest does not match its canonical payload";
  const fields = new Map(targetSchema.map((field) => [field.path, field]));
  for (const [index, example] of (task.examples ?? []).entries()) {
    if (example.digest !== digest(examplePayload(example))) return `taskSpec.examples[${index}].digest does not match its canonical payload`;
    const prepared = prepareContent(example.content, example.contentType ?? "text");
    if (prepared.error) return `taskSpec.examples[${index}] content is invalid: ${prepared.error}`;
    const preparedText = prepared.text ?? "";
    for (const [proposalIndex, proposal] of example.proposals.entries()) {
      const field = fields.get(proposal.fieldPath);
      if (!field) return `taskSpec.examples[${index}].proposals[${proposalIndex}] references unknown fieldPath "${proposal.fieldPath}"`;
      if (!valueMatches(proposal.candidateValue, field)) return `taskSpec.examples[${index}].proposals[${proposalIndex}] candidateValue does not match ${field.type}`;
      if (!proposal.excerpt || !preparedText.includes(proposal.excerpt)) return `taskSpec.examples[${index}].proposals[${proposalIndex}] excerpt is not grounded in prepared example content`;
    }
  }
  return undefined;
}
