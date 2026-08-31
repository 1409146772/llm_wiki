/**
 * Shared helpers for pulling a JSON object out of an LLM response.
 *
 * Extracted from `sweep-reviews.ts` so structured-output callers (ingest
 * judges, Jira analysis, …) can reuse the balanced-brace walk without
 * importing those modules' heavy store/command dependency graph.
 */

/**
 * Extract a JSON object from an LLM response.
 *
 * Handles:
 *   - Bare JSON: `{...}`
 *   - Fenced: ` ```json\n{...}\n``` ` or single-line ` ```{...}``` `
 *   - Wrapped in prose: find the first balanced `{...}` object via brace depth
 *
 * Returns empty string if no balanced object is found.
 */
export function extractJsonObject(raw: string): string {
  let text = raw.trim()

  // Strip an opening ```json or ``` fence (with or without newline)
  text = text.replace(/^```(?:json)?\s*/i, "")
  // Strip a trailing ``` fence
  text = text.replace(/\s*```\s*$/i, "")
  text = text.trim()

  // Walk brace depth to find the first complete {...}, respecting strings/escapes
  const start = text.indexOf("{")
  if (start === -1) return ""

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\" && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return ""
}
