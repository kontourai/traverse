/**
 * Exact occurrence resolution for provenance excerpts.
 *
 * This module deliberately has no fuzzy matching path. A locator is emitted
 * only for an exact span enumerated from the complete prepared text.
 */

export const EXACT_OCCURRENCE_RESOLVER_VERSION = "exact-occurrence-v1";

export interface ExactOccurrence {
  /** Zero-based index in the exact-match enumeration. */
  index: number;
  /** UTF-16 offset in the complete prepared text. */
  start: number;
  /** Exclusive UTF-16 offset in the complete prepared text. */
  end: number;
}

/**
 * Metadata attached to a verified proposal's provenance.
 *
 * The resolved occurrence (`resolverVersion`, `count`, `selected`) is what a
 * proposal is grounded in. `selection` and `hintUsed` record HOW it was
 * reached and are not part of its identity: a model may send the optional
 * hint in one run and omit it in the next and resolve the same span. Compare
 * two resolutions with `sameResolvedOccurrence`, not by deep equality.
 */
export interface ExactOccurrenceResolution {
  resolverVersion: typeof EXACT_OCCURRENCE_RESOLVER_VERSION;
  /** Number of exact excerpt matches in the complete prepared text. */
  count: number;
  /** Selected exact match, indexed in source order from zero. */
  selected: ExactOccurrence;
  /** Whether selection followed a valid provider-supplied hint or source order. Not identity; varies between runs. */
  selection: "occurrence-hint" | "source-order";
  /** True only when a bounded, exact-match occurrence hint was used. Not identity; varies between runs. */
  hintUsed: boolean;
  /** More than one exact source span was available for this excerpt. */
  ambiguous: boolean;
}

/**
 * Whether two resolutions name the same occurrence: same resolver version,
 * same exact-match count and same selected index and span. `selection` and
 * `hintUsed` are ignored (`ambiguous` is derived from `count`).
 */
export function sameResolvedOccurrence(
  a: Pick<ExactOccurrenceResolution, "resolverVersion" | "count" | "selected">,
  b: Pick<ExactOccurrenceResolution, "resolverVersion" | "count" | "selected">,
): boolean {
  return a.resolverVersion === b.resolverVersion
    && a.count === b.count
    && a.selected.index === b.selected.index
    && a.selected.start === b.selected.start
    && a.selected.end === b.selected.end;
}

export interface ResolveExactOccurrenceInput {
  /** Complete prepared text, never a provider-supplied representation. */
  text: string;
  /** Exact prepared-text slice handed to this provider operation. */
  visibleText: string;
  /** UTF-16 offset of visibleText[0] in the complete prepared text. */
  visibleStart: number;
  /** The exact, already non-blank excerpt to enumerate. */
  excerpt: string;
  /**
   * Optional untrusted, one-based occurrence hint from a provider. It is used
   * only when it is an integer in the exact enumeration's bounds.
   */
  occurrenceHint?: unknown;
  /** Stable proposal identity used to allocate unhinted repeated proposals. */
  sourceOrderKey: string;
}

interface AllocationState {
  used: Set<number>;
}

/** Enumerate every exact match, including overlaps, in deterministic source order. */
export function enumerateExactOccurrences(text: string, excerpt: string): ExactOccurrence[] {
  if (!excerpt) return [];
  const occurrences: ExactOccurrence[] = [];
  let from = 0;
  while (from <= text.length - excerpt.length) {
    const start = text.indexOf(excerpt, from);
    if (start < 0) break;
    occurrences.push({ index: occurrences.length, start, end: start + excerpt.length });
    from = start + 1;
  }
  return occurrences;
}

/**
 * Stateful exact resolver. Its state is deliberately keyed by a caller's
 * deterministic proposal identity, never by promise completion order.
 */
export class ExactOccurrenceResolver {
  private readonly allocations = new Map<string, AllocationState>();
  /**
   * Full-text enumerations memoized per excerpt. Keyed on excerpt only while
   * the complete text is unchanged; a different text clears the cache, so a
   * resolver reused across texts can never return another text's spans.
   */
  private cachedText: string | undefined;
  private readonly fullTextOccurrences = new Map<string, FullTextOccurrences>();

  /** `enumerate` is injectable only so tests can count full-text enumerations. */
  constructor(private readonly enumerate: typeof enumerateExactOccurrences = enumerateExactOccurrences) {}

  resolve(input: ResolveExactOccurrenceInput): ExactOccurrenceResolution | undefined {
    if (!(Number.isInteger(input.visibleStart) && input.visibleStart >= 0)) return undefined;
    if (input.text.slice(input.visibleStart, input.visibleStart + input.visibleText.length) !== input.visibleText) return undefined;
    const { occurrences, occurrenceBySpan } = this.fullTextEnumeration(input.text, input.excerpt);
    const visibleOccurrences = this.enumerate(input.visibleText, input.excerpt)
      .map((occurrence) => {
        const start = input.visibleStart + occurrence.start;
        return occurrenceBySpan.get(`${start}:${start + input.excerpt.length}`);
      })
      .filter((occurrence): occurrence is ExactOccurrence => occurrence !== undefined);
    if (occurrences.length === 0 || visibleOccurrences.length === 0) return undefined;

    const state = this.allocations.get(input.sourceOrderKey) ?? { used: new Set<number>() };
    this.allocations.set(input.sourceOrderKey, state);
    const hintedVisibleIndex = validHintIndex(input.occurrenceHint, visibleOccurrences.length);
    const selected = hintedVisibleIndex === undefined
      ? visibleOccurrences.find((occurrence) => !state.used.has(occurrence.index)) ?? visibleOccurrences[visibleOccurrences.length - 1]
      : visibleOccurrences[hintedVisibleIndex];
    state.used.add(selected.index);

    return {
      resolverVersion: EXACT_OCCURRENCE_RESOLVER_VERSION,
      count: occurrences.length,
      // Copy: cached occurrences are shared across resolutions and must not
      // alias into caller-owned proposal provenance.
      selected: { ...selected },
      selection: hintedVisibleIndex === undefined ? "source-order" : "occurrence-hint",
      hintUsed: hintedVisibleIndex !== undefined,
      ambiguous: occurrences.length > 1,
    };
  }

  private fullTextEnumeration(text: string, excerpt: string): FullTextOccurrences {
    if (this.cachedText !== text) {
      this.cachedText = text;
      this.fullTextOccurrences.clear();
    }
    let cached = this.fullTextOccurrences.get(excerpt);
    if (!cached) {
      const occurrences = this.enumerate(text, excerpt);
      cached = {
        occurrences,
        occurrenceBySpan: new Map(occurrences.map((occurrence) => [`${occurrence.start}:${occurrence.end}`, occurrence])),
      };
      this.fullTextOccurrences.set(excerpt, cached);
    }
    return cached;
  }
}

interface FullTextOccurrences {
  occurrences: ExactOccurrence[];
  occurrenceBySpan: Map<string, ExactOccurrence>;
}

function validHintIndex(hint: unknown, count: number): number | undefined {
  if (!(typeof hint === "number" && Number.isInteger(hint) && hint >= 1 && hint <= count)) return undefined;
  return hint - 1;
}
