// Per-node inspection payload. Every tier returns its prompt, the input it was
// given, the output it produced, and the validation that ran on that output —
// so the UI can show exactly what happened at each step (prompt / IO / checks).

import { z } from 'zod';

export interface Validation {
  schema: string;        // the Zod schema the output was checked against
  ok: boolean;
  error?: string;        // formatted issues when ok === false
  note?: string;         // human note on what the schema enforces / known gaps
}

export interface TierResult<T> {
  prompt: { system: string; user: string }; // the actual prompt (shown even in stub mode)
  input: unknown;                            // what this tier was fed
  output: T;                                 // the validated result
  validation: Validation;
}

export function validateAgainst<T>(
  schema: z.ZodType<T>,
  name: string,
  value: unknown,
  note?: string,
): Validation {
  const r = schema.safeParse(value);
  if (r.success) return { schema: name, ok: true, note };
  return {
    schema: name,
    ok: false,
    note,
    error: r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
  };
}
