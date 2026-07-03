// Originated-generic target schema fixture. NOT derived from any real consumer
// dataset — a small, clearly-fictional "activity listing" shape used to
// exercise Traverse's real code paths (required vs. optional fields, string vs.
// number types) without carrying any domain vocabulary.

import type { TargetFieldSchema } from "../../src/types.js";

export const genericTargetSchema: TargetFieldSchema[] = [
  {
    path: "title",
    type: "string",
    description: "The name of the activity or session.",
    required: true,
  },
  {
    path: "priceAmount",
    type: "number",
    description: "The drop-in price in whole currency units.",
  },
  {
    path: "scheduleSummary",
    type: "string",
    description: "A short human-readable summary of when the activity runs.",
  },
  {
    path: "schedules[].startDate",
    type: "date",
    description: "The start date of one schedule item in a repeating series.",
  },
];
