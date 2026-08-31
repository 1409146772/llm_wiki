import { describe, it, expect } from "vitest"
import { buildJiraJql, parseJiraJql, type JiraFilterState } from "./jira-jql"

const state = (over: Partial<JiraFilterState>): Omit<JiraFilterState, "custom" | "raw"> => ({
  scope: "all",
  types: [],
  priorities: [],
  customClauses: [],
  orderBy: "",
  ...over,
})

describe("buildJiraJql", () => {
  it("emits only the scope clause", () => {
    expect(buildJiraJql(state({ scope: "assignee" }))).toBe(
      "assignee = currentUser() order by updated DESC",
    )
    expect(buildJiraJql(state({ scope: "reporter" }))).toBe(
      "reporter = currentUser() order by updated DESC",
    )
  })
  it("emits issuetype and priority in (...)", () => {
    expect(buildJiraJql(state({ types: ["任务", "缺陷"] }))).toBe(
      "issuetype in (任务, 缺陷) order by updated DESC",
    )
    expect(buildJiraJql(state({ scope: "assignee", types: ["任务"], priorities: ["高"] }))).toBe(
      "assignee = currentUser() AND issuetype in (任务) AND priority in (高) order by updated DESC",
    )
  })
  it("uses in (...) even for a single value", () => {
    expect(buildJiraJql(state({ types: ["任务"] }))).toBe("issuetype in (任务) order by updated DESC")
  })
  it("quotes names with spaces or punctuation, leaves CJK unquoted", () => {
    expect(buildJiraJql(state({ types: ["New Feature"] }))).toBe(
      'issuetype in ("New Feature") order by updated DESC',
    )
  })
  it("with no clauses still emits a valid order-by", () => {
    expect(buildJiraJql(state({}))).toBe("order by updated DESC")
  })
  it("re-emits custom clauses after the scope clause, before issuetype", () => {
    expect(
      buildJiraJql(
        state({ scope: "assignee", customClauses: ["project = AERDM", "status != Closed"], types: ["任务"] }),
      ),
    ).toBe(
      "assignee = currentUser() AND project = AERDM AND status != Closed AND issuetype in (任务) order by updated DESC",
    )
  })
  it("wraps OR chains in parentheses", () => {
    expect(
      buildJiraJql(state({ customClauses: ["issuetype in (任务) OR priority = 高"] })),
    ).toBe("(issuetype in (任务) OR priority = 高) order by updated DESC")
  })
  it("drops owner clauses from customClauses per scope rules", () => {
    // scope=all: every single-clause owner restriction is removed …
    expect(
      buildJiraJql(state({ scope: "all", customClauses: ["reporter = currentUser()", "project = X"] })),
    ).toBe("project = X order by updated DESC")
    // … and a duplicate of the active scope clause is not emitted twice,
    // while a DIFFERENT owner restriction is preserved.
    expect(
      buildJiraJql(
        state({ scope: "assignee", customClauses: ["assignee = currentUser()", "reporter = currentUser()"] }),
      ),
    ).toBe("assignee = currentUser() AND reporter = currentUser() order by updated DESC")
  })
  it("preserves a custom ORDER BY verbatim instead of the default", () => {
    expect(
      buildJiraJql(state({ scope: "assignee", orderBy: "ORDER BY status ASC, updated DESC" })),
    ).toBe("assignee = currentUser() ORDER BY status ASC, updated DESC")
  })
  it("treats a parenthesized owner clause as an owner clause", () => {
    expect(buildJiraJql(state({ scope: "all", customClauses: ["(assignee = currentUser())"] }))).toBe(
      "order by updated DESC",
    )
  })
})

describe("parseJiraJql", () => {
  it("parses the new default into scope=assignee", () => {
    const r = parseJiraJql("assignee = currentUser() order by updated DESC")
    expect(r.scope).toBe("assignee")
    expect(r.types).toEqual([])
    expect(r.custom).toBe(false)
    expect(r.customClauses).toEqual([])
    expect(r.orderBy).toBe("order by updated DESC")
  })
  it("parses the old defects default into types", () => {
    const r = parseJiraJql("issuetype in (缺陷,Bug) order by updated DESC")
    expect(r.scope).toBe("all")
    expect(r.types).toEqual(["缺陷", "Bug"])
    expect(r.custom).toBe(false)
  })
  it("accepts `= X` and `in (...)` for both fields", () => {
    expect(parseJiraJql("issuetype = 任务 AND priority = 高").types).toEqual(["任务"])
    expect(parseJiraJql("issuetype = 任务 AND priority = 高").priorities).toEqual(["高"])
  })
  it("is case / whitespace insensitive", () => {
    expect(parseJiraJql("ASSIGNEE=currentUser()").scope).toBe("assignee")
    expect(parseJiraJql("issuetype   in   (  任务 , 缺陷 )  ").types).toEqual(["任务", "缺陷"])
  })
  it("unquotes values", () => {
    expect(parseJiraJql('issuetype in ("New Feature", 任务)').types).toEqual(["New Feature", "任务"])
  })
  it("keeps unrepresentable clauses verbatim instead of destroying them", () => {
    expect(parseJiraJql("project = AERDM order by updated DESC").customClauses).toEqual([
      "project = AERDM",
    ])
    // Second, conflicting owner clause is kept as custom …
    const both = parseJiraJql("assignee = currentUser() AND reporter = currentUser()")
    expect(both.scope).toBe("assignee")
    expect(both.customClauses).toEqual(["reporter = currentUser()"])
    // … while a duplicated owner is dropped (no-op clause).
    expect(
      parseJiraJql("assignee = currentUser() AND assignee = currentUser()").customClauses,
    ).toEqual([])
    // Negated field clauses are opaque.
    expect(parseJiraJql("issuetype not in (子任务)").customClauses).toEqual(["issuetype not in (子任务)"])
    // An OR chain is one indivisible entry (splitting would change semantics).
    expect(parseJiraJql("issuetype = 任务 OR priority = 高").customClauses).toEqual([
      "issuetype = 任务 OR priority = 高",
    ])
    expect(parseJiraJql("issuetype = 任务 OR priority = 高").types).toEqual([])
    for (const jql of [
      "project = AERDM",
      "assignee = currentUser() AND reporter = currentUser()",
      "issuetype not in (子任务)",
      "issuetype = 任务 OR priority = 高",
    ]) {
      expect(parseJiraJql(jql).custom).toBe(true)
    }
  })
  it("preserves a multi-key ORDER BY", () => {
    expect(parseJiraJql("assignee = currentUser() ORDER BY status ASC, updated DESC").orderBy).toBe(
      "ORDER BY status ASC, updated DESC",
    )
  })
  it("round-trips: build(parse(build(x))) === build(x)", () => {
    for (const x of [
      "assignee = currentUser() order by updated DESC",
      "issuetype in (缺陷, Bug) order by updated DESC",
      "reporter = currentUser() AND priority in (高) order by updated DESC",
      // custom-clause legacies: preserved through the builder
      "project = X AND assignee = currentUser() order by updated DESC",
      "issuetype in (任务) OR priority = 高 order by updated DESC",
      "assignee = currentUser() AND reporter = currentUser()",
      "assignee = currentUser() ORDER BY status ASC, updated DESC",
    ]) {
      const built = buildJiraJql(parseJiraJql(x))
      expect(buildJiraJql(parseJiraJql(built))).toBe(built)
    }
  })
  it("scope switching keeps custom clauses", () => {
    const r = parseJiraJql("project = X AND assignee = currentUser() order by updated DESC")
    // assignee → reporter
    expect(buildJiraJql({ ...r, scope: "reporter" })).toBe(
      "reporter = currentUser() AND project = X order by updated DESC",
    )
    // all → owner restriction gone, project clause intact
    expect(buildJiraJql({ ...r, scope: "all" })).toBe("project = X order by updated DESC")
  })
})
