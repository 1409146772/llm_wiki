/**
 * Pure Jira JQL manipulation, shared by the settings filter builder and the
 * Jira view's scope toggle.
 *
 * Deliberately dependency-free (no imports, no store, no fetch) so it can be
 * unit-tested in isolation and reused from any environment. It models the
 * narrow slice of JQL the visual builder can express:
 *
 *   [assignee = currentUser() | reporter = currentUser()]
 *     [AND issuetype in (...)] [AND priority in (...)]
 *     order by updated DESC
 *
 * Anything richer (project =, status !=, OR between clauses, functions other
 * than currentUser()) is "custom": the builder can't represent it, so
 * `parseJiraJql` flags `custom` and the raw textarea stays authoritative.
 */

export type JiraScope = "assignee" | "reporter" | "all"

export interface JiraFilterState {
  scope: JiraScope
  /** Issue-type display names, quotes stripped (e.g. ["任务", "缺陷"]). */
  types: string[]
  /** Priority display names, quotes stripped (e.g. ["高"]). */
  priorities: string[]
  /** True when the JQL has parts the builder can't represent — controls disable. */
  custom: boolean
  /** The original input, for the advanced editor to stay lossless. */
  raw: string
}

const CJK_RANGE = "一-龥"
// Unquoted JQL identifiers are safe for letters/digits/underscore/CJK. Anything
// else (spaces, punctuation, leading digit) gets quoted.
const NEEDS_QUOTE = new RegExp(`^[A-Za-z0-9_${CJK_RANGE}]+$`)

/** Split a JQL string at the first top-level `order by`/`group by`. */
function splitOrderBy(jql: string): { where: string; order: string } {
  let depth = 0
  let quote: string | null = null
  const n = jql.length
  for (let i = 0; i < n; i++) {
    const c = jql[i]
    if (quote) {
      if (c === "\\") i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === "(") {
      depth++
      continue
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0) {
      const m = /^\s+(order\s+by|group\s+by)\s+/i.exec(jql.slice(i))
      if (m) {
        return { where: jql.slice(0, i).trim(), order: jql.slice(i).trim() }
      }
    }
  }
  return { where: jql.trim(), order: "" }
}

interface Segment {
  /** Normalized connector preceding this clause: "" (first) | "AND" | "OR". */
  precede: string
  text: string
}

/** Split a WHERE body into top-level clauses on `AND`/`OR`, quote/paren aware. */
function splitTopLevel(where: string): Segment[] {
  const segs: Segment[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ""
  let precede = ""
  const n = where.length
  const flush = () => {
    const t = cur.trim()
    if (t) segs.push({ precede, text: t })
    cur = ""
  }
  for (let i = 0; i < n; i++) {
    const c = where[i]
    if (quote) {
      cur += c
      if (c === "\\") {
        if (i + 1 < n) cur += where[++i]
      } else if (c === quote) {
        quote = null
      }
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    if (c === "(") {
      depth++
      cur += c
      continue
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1)
      cur += c
      continue
    }
    if (depth === 0) {
      const m = /^\s+(and|or)\s+/i.exec(where.slice(i))
      if (m) {
        flush()
        precede = m[1].toUpperCase()
        i += m[0].length - 1
        continue
      }
    }
    cur += c
  }
  flush()
  return segs
}

function normalizeClause(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase()
}

/** A clause that is exactly `assignee = currentUser()` / `reporter = currentUser()` (optionally one wrapping paren). */
function currentUserField(text: string): "assignee" | "reporter" | null {
  const t = normalizeClause(text)
  let m = /^(assignee|reporter)\s*=\s*currentUser\(\)$/i.exec(t)
  if (m) return m[1].toLowerCase() as "assignee" | "reporter"
  m = /^\((assignee|reporter)\s*=\s*currentUser\(\)\)$/i.exec(t)
  return m ? (m[1].toLowerCase() as "assignee" | "reporter") : null
}

function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1).replace(/\\(["'])/g, "$1")
  }
  return t
}

function quoteIfNeeded(name: string): string {
  const trimmed = name.trim()
  if (NEEDS_QUOTE.test(trimmed)) return trimmed
  return `"${trimmed.replace(/(["\\])/g, "\\$1")}"`
}

/** Split a parenthesized `in (...)` value list on top-level commas. */
function splitValues(inner: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ""
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quote) {
      cur += c
      if (c === "\\") {
        if (i + 1 < inner.length) cur += inner[++i]
      } else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    if (c === "(") depth++
    else if (c === ")") depth--
    if (c === "," && depth === 0) {
      out.push(cur)
      cur = ""
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map(unquote).filter((s) => s.length > 0)
}

/** Match an `issuetype`/`priority` clause to its field + value list. */
function fieldClause(text: string, field: string): { negated: boolean; values: string[] } | null {
  // Normalize whitespace but PRESERVE case: issue-type/priority names are
  // case-sensitive display values (e.g. "New Feature", "Bug"). Only the field
  // keyword is matched case-insensitively via /i.
  const t = text.trim().replace(/\s+/g, " ")
  const negIn = new RegExp(`^${field}\\s+not\\s+in\\s*\\((.*)\\)$`, "i").exec(t)
  if (negIn) return { negated: true, values: splitValues(negIn[1]) }
  const negEq = new RegExp(`^${field}\\s*!=\\s*(.+)$`, "i").exec(t)
  if (negEq) return { negated: true, values: [unquote(negEq[1])] }
  const inM = new RegExp(`^${field}\\s+in\\s*\\((.*)\\)$`, "i").exec(t)
  if (inM) return { negated: false, values: splitValues(inM[1]) }
  const eqM = new RegExp(`^${field}\\s*=\\s*(.+)$`, "i").exec(t)
  if (eqM) return { negated: false, values: [unquote(eqM[1])] }
  return null
}

function joinWhere(segments: Segment[]): string {
  // Do NOT strip `()`: `currentUser()` is a function call, not an empty group.
  return segments
    .map((s, i) => (i === 0 ? s.text : `${s.precede || "AND"} ${s.text}`))
    .join(" ")
    .trim()
}

/**
 * Build a JQL string from filter state. Always appends `order by updated DESC`.
 * Emits `in (...)` for both single- and multi-value fields.
 */
export function buildJiraJql(f: Omit<JiraFilterState, "custom" | "raw">): string {
  const clauses: string[] = []
  if (f.scope === "assignee") clauses.push("assignee = currentUser()")
  else if (f.scope === "reporter") clauses.push("reporter = currentUser()")
  if (f.types.length > 0) clauses.push(`issuetype in (${f.types.map(quoteIfNeeded).join(", ")})`)
  if (f.priorities.length > 0) clauses.push(`priority in (${f.priorities.map(quoteIfNeeded).join(", ")})`)
  const where = clauses.join(" AND ")
  return where ? `${where} order by updated DESC` : "order by updated DESC"
}

/**
 * Best-effort parse of a JQL into filter state. Sets `custom` (and disables the
 * builder) when anything unrepresentable is present: an OR connector, a
 * negated type/priority, both currentUser clauses, or any other clause.
 */
export function parseJiraJql(jql: string): JiraFilterState {
  const raw = jql.trim()
  const { where } = splitOrderBy(raw)
  const segs = splitTopLevel(where)
  let scope: JiraScope = "all"
  const types: string[] = []
  const priorities: string[] = []
  let custom = false

  for (const seg of segs) {
    if (seg.precede === "OR") custom = true
    const cu = currentUserField(seg.text)
    if (cu) {
      if (scope !== "all" && scope !== cu) custom = true
      scope = cu
      continue
    }
    const typeM = fieldClause(seg.text, "issuetype")
    if (typeM) {
      if (typeM.negated) custom = true
      else types.push(...typeM.values)
      continue
    }
    const prioM = fieldClause(seg.text, "priority")
    if (prioM) {
      if (prioM.negated) custom = true
      else priorities.push(...prioM.values)
      continue
    }
    custom = true // any other clause (project=, status, text~, …)
  }

  return { scope, types, priorities, custom, raw }
}

/**
 * Rewrite a base JQL to force a scope, without ever mutating the base. Used by
 * the Jira view's scope toggle (which re-queries but does NOT persist).
 *
 * - scope "all": return the base unchanged (i.e. "run the configured query").
 *   With a default that already contains `assignee = currentUser()`, "all"
 *   still yields only your issues — the UI labels it "按设置中的 JQL".
 * - scope "assignee"/"reporter": drop any existing top-level
 *   `assignee|reporter = currentUser()` clauses, then AND the requested one.
 *   Parenthesized/inner occurrences are left alone and the clause is appended
 *   redundantly (semantically safe).
 */
export function applyJiraScope(baseJql: string, scope: JiraScope): string {
  const base = baseJql.trim()
  if (scope === "all") return base
  const { where, order } = splitOrderBy(base)
  const survivors = splitTopLevel(where).filter((s) => currentUserField(s.text) === null)
  const cleaned = joinWhere(survivors)
  const clause = scope === "assignee" ? "assignee = currentUser()" : "reporter = currentUser()"
  const newWhere = cleaned ? `${cleaned} AND ${clause}` : clause
  return order ? `${newWhere} ${order}` : newWhere
}
