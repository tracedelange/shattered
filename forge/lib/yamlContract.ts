// A strict output contract appended to every tier's system prompt. Weak models
// (and sometimes strong ones) ignore "match the schema" and emit a markdown
// design doc — headings, **bold**, `---` separators — which fails YAML parsing.
// Showing an explicit skeleton to copy + hard format rules fixes most of that.

export const STRICT_YAML_RULES = [
  'STRICT OUTPUT — follow exactly:',
  '- Respond with ONE ```yaml fenced block and NOTHING else: no prose, no markdown',
  '  headings (#), no **bold**, no `---` document separators, no text before/after.',
  '- It must parse as a SINGLE YAML document using the exact field names shown above.',
  '- Any string value containing : # - " or other punctuation must be quoted or a',
  '  block scalar (key: |).',
].join('\n');

/** Wrap a YAML skeleton + the strict rules into a prompt block. */
export function outputContract(skeleton: string): string {
  return [
    '# REQUIRED OUTPUT SHAPE — copy this structure, fill the values:',
    '```yaml',
    skeleton.trim(),
    '```',
    '',
    STRICT_YAML_RULES,
  ].join('\n');
}
