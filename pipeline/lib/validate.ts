// Shared "call LLM, parse YAML, validate against Zod, repair on failure"
// helper. Both pipelines use this for their primary LLM call so they get
// uniform error handling and the same one-shot repair behavior.

import yaml from 'js-yaml';
import { z } from 'zod';
import { callLlm, extractYaml } from './llm.ts';

interface ValidateOpts<T> {
  label: string;            // tag used in console output: "gardener", "implementer"
  system: string[];
  user: string;
  schema: z.ZodType<T>;
  /** Run the LLM without tools (single-shot generation). See CallOptions. */
  disableTools?: boolean;
}

// Returns { value, raw }. `raw` is the (possibly repaired) LLM output, useful
// for dry-run printing. Throws if neither the first call nor the one-shot
// repair produced parseable + valid output.
export async function callAndValidate<T>(
  opts: ValidateOpts<T>,
): Promise<{ value: T; raw: string }> {
  const { label, system, user, schema, disableTools } = opts;
  let raw = await callLlm({ system, user, disableTools });
  const firstAttempt = tryParseAndValidate(raw, schema);
  if (firstAttempt.ok) return { value: firstAttempt.value, raw };

  console.error(`[${label}] output failed validation:\n${firstAttempt.error}`);
  console.error(`[${label}] asking LLM to repair...`);
  raw = await callLlm({ system, user: repairPrompt(raw, firstAttempt.error), disableTools });
  const second = tryParseAndValidate(raw, schema);
  if (second.ok) {
    console.error(`[${label}] repair succeeded.`);
    return { value: second.value, raw };
  }

  console.error(`[${label}] repair failed. Final raw output:\n${raw}`);
  throw new Error(`[${label}] LLM output failed validation twice:\n${second.error}`);
}

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function tryParseAndValidate<T>(raw: string, schema: z.ZodType<T>): ParseResult<T> {
  let parsed: unknown;
  try {
    parsed = yaml.load(extractYaml(raw));
  } catch (err) {
    return { ok: false, error: `YAML parse error: ${(err as Error).message}` };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: formatZodError(result.error) };
  }
  return { ok: true, value: result.data };
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '<root>';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}

function repairPrompt(prevRaw: string, error: string): string {
  return [
    'Your previous response did not pass validation. The errors were:',
    '',
    error,
    '',
    'Below is your previous output verbatim. Re-emit the SAME content with',
    'the listed issues corrected. Common fixes:',
    '- YAML parse errors: wrap free-text fields in block scalars (| or >),',
    '  or single-quote items containing : - — # [ ] { } | & * ? > <.',
    '- Type errors: emit numbers as numbers, strings as strings, etc.',
    '- Enum errors: pick exactly one of the allowed values listed in the message.',
    '- ID format errors: use opp_NNN with at least 3 zero-padded digits.',
    '',
    'Do not change IDs, priorities, statuses, or content — only fix the issues',
    'identified above. Output ONLY the corrected YAML in a single ```yaml fenced block.',
    '',
    '```yaml',
    prevRaw.replace(/```/g, "'''"),
    '```',
  ].join('\n');
}
