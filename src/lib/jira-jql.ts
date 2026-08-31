/**
 * Pure Jira JQL manipulation, used by the Jira view's filter bar.
 *
 * Deliberately dependency-free (no imports, no store, no fetch) so it can be
 * unit-tested in isolation and reused from any environment. It models the
 * slice of JQL the visual filter controls express:
 *
 *   [assignee = currentUser() | reporter = currentUser()]
 *     [AND issuetype in (...)] [AND priority in (...)]
 *     [order by …]
 *
 * Anything richer (project =, status clauses, OR between clauses, negated
 * type/priority, functions other than currentUser()) can't be edited by the
 * controls, but must not be destroyed by them: `parseJiraJql` keeps such
 * clauses verbatim in `customClauses` (an OR chain stays one indivisible
 * entry) and preserves a custom top-level ORDER BY, and `buildJiraJql`
 * re-emits them. There is no raw-JQL editor anymore — filters are managed
 * entirely from the Jira page and persisted into `config.jql`.
 */

export type JiraScope = "assignee" | "reporter" | "all"

export interface JiraFilterState {
  scope: JiraScope
  /** Issue-type display names, quotes stripped (e.g. ["任务", "缺陷"]). */
  types: string[]
  /** Priority display names, quotes stripped (e.g. ["高"]). */
  priorities: string[]
  /**
   * Top-level clauses the controls can't express, kept verbatim in original
   * order. An OR-connected chain is a single entry (never split — splitting
   * would change its semantics). Re-emitted by `buildJiraJql`.
   */
  customClauses: string[]
  /** Derived: whether `customClauses` is non-empty. */
  custom: boolean
  /**
   * The verbatim top-level `order by` / `group by` segment ("" when the
   * query has none — `buildJiraJql` then applies the default).
   */
  orderBy: string
  /** The original input. */
  raw: string
}

/** What `buildJiraJql` needs; `JiraFilterState` structurally satisfies it. */
export interface JiraFilterInput {
  scope: JiraScope
  types: string[]
  priorities: string[]
  customClauses?: string[]
  orderBy?: string
}

const DEFAULT_ORDER_BY = "order by updated DESC"

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

/** The owner field if `entry` is a single (optionally parenthesized)
 *  currentUser clause; null for anything else, incl. OR chains. */
function singleOwnerField(entry: string): "assignee" | "reporter" | null {
  const segs = splitTopLevel(entry)
  if (segs.length !== 1) return null
  return currentUserField(segs[0].text)
}

/** Whether `entry` combines clauses with a top-level OR. */
function hasTopLevelOr(entry: string): boolean {
  const segs = splitTopLevel(entry)
  return segs.length > 1 && segs.some((s) => s.precede === "OR")
}

/**
 * Build a JQL string from filter state. Emits the owner clause first, then
 * the custom clauses verbatim (OR-chained entries get wrapped in parentheses,
 * since the controls treat them as one indivisible unit), then issuetype /
 * priority, then `orderBy` (defaulting to `order by updated DESC`).
 * Emits `in (...)` for both single- and multi-value fields.
 *
 * Redundancy rules for owner clauses inside `customClauses`:
 * - scope "all" drops every single-clause owner restriction ("all" means
 *   unrestricted).
 * - a clause duplicating the active scope clause is dropped (it's already
 *   emitted above); a DIFFERENT owner clause is kept (the builder can't
 *   express owner=assignee-plus-reporter, but must not silently loosen a
 *   restriction it inherited).
 */
export function buildJiraJql(f: JiraFilterInput): string {
  const clauses: string[] = []
  if (f.scope === "assignee") clauses.push("assignee = currentUser()")
  else if (f.scope === "reporter") clauses.push("reporter = currentUser()")
  for (const entry of f.customClauses ?? []) {
    const text = entry.trim()
    if (!text) continue
    const owner = singleOwnerField(text)
    if (owner && (f.scope === "all" || f.scope === owner)) continue
    clauses.push(hasTopLevelOr(text) ? `(${text})` : text)
  }
  if (f.types.length > 0) clauses.push(`issuetype in (${f.types.map(quoteIfNeeded).join(", ")})`)
  if (f.priorities.length > 0) clauses.push(`priority in (${f.priorities.map(quoteIfNeeded).join(", ")})`)
  const where = clauses.join(" AND ")
  const order = (f.orderBy ?? "").trim() || DEFAULT_ORDER_BY
  return where ? `${where} ${order}` : order
}

/**
 * Best-effort parse of a JQL into filter state. Clauses the controls can't
 * express — OR chains, negated type/priority, a second conflicting owner
 * clause, project/status/text/etc. — are kept verbatim in `customClauses`
 * so a later `buildJiraJql` re-emits them unchanged. `custom` flags their
 * presence for callers that want to warn the user.
 */
export function parseJiraJql(jql: string): JiraFilterState {
  const raw = jql.trim()
  const { where, order } = splitOrderBy(raw)
  const segs = splitTopLevel(where)
  let scope: JiraScope = "all"
  const types: string[] = []
  const priorities: string[] = []
  const customClauses: string[] = []

  // Group segments into OR-connected chains: an AND (or the first segment)
  // starts a new group; an OR extends the current one. Multi-segment groups
  // are opaque to the controls and kept whole.
  const groups: Segment[][] = []
  let group: Segment[] = []
  for (const seg of segs) {
    if (group.length > 0 && seg.precede === "OR") {
      group.push(seg)
    } else {
      if (group.length > 0) groups.push(group)
      group = [seg]
    }
  }
  if (group.length > 0) groups.push(group)

  for (const g of groups) {
    if (g.length > 1) {
      customClauses.push(g.map((s) => s.text).join(" OR "))
      continue
    }
    const text = g[0].text
    const cu = currentUserField(text)
    if (cu) {
      if (scope === "all") scope = cu
      else if (scope !== cu) customClauses.push(text)
      // A duplicate of the same owner clause is a no-op; drop it.
      continue
    }
    const typeM = fieldClause(text, "issuetype")
    if (typeM) {
      if (typeM.negated) customClauses.push(text)
      else types.push(...typeM.values)
      continue
    }
    const prioM = fieldClause(text, "priority")
    if (prioM) {
      if (prioM.negated) customClauses.push(text)
      else priorities.push(...prioM.values)
      continue
    }
    customClauses.push(text) // any other clause (project=, status, text~, …)
  }

  return {
    scope,
    types,
    priorities,
    customClauses,
    custom: customClauses.length > 0,
    orderBy: order,
    raw,
  }
}
