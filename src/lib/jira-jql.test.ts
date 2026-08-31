import { describe, it, expect } from "vitest"
import {
  buildJiraJql,
  parseJiraJql,
  applyJiraScope,
  type JiraFilterState,
} from "./jira-jql"

const state = (over: Partial<JiraFilterState>): Omit<JiraFilterState, "custom" | "raw"> => ({
  scope: "all",
  types: [],
  priorities: [],
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
})

describe("parseJiraJql", () => {
  it("parses the new default into scope=assignee", () => {
    const r = parseJiraJql("assignee = currentUser() order by updated DESC")
    expect(r.scope).toBe("assignee")
    expect(r.types).toEqual([])
    expect(r.custom).toBe(false)
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
  it("flags unrepresentable clauses as custom", () => {
    expect(parseJiraJql("project = AERDM order by updated DESC").custom).toBe(true)
    expect(parseJiraJql("assignee = currentUser() AND reporter = currentUser()").custom).toBe(true)
    expect(parseJiraJql("issuetype not in (子任务)").custom).toBe(true)
    expect(parseJiraJql("issuetype = 任务 OR priority = 高").custom).toBe(true)
  })
  it("round-trips: build(parse(build(x))) === build(x)", () => {
    for (const x of [
      "assignee = currentUser() order by updated DESC",
      "issuetype in (缺陷, Bug) order by updated DESC",
      "reporter = currentUser() AND priority in (高) order by updated DESC",
    ]) {
      const built = buildJiraJql(parseJiraJql(x))
      expect(buildJiraJql(parseJiraJql(built))).toBe(built)
    }
  })
})

describe("applyJiraScope", () => {
  it("returns base unchanged for scope=all", () => {
    const base = "assignee = currentUser() order by updated DESC"
    expect(applyJiraScope(base, "all")).toBe(base)
  })
  it("replaces assignee with reporter", () => {
    expect(
      applyJiraScope("assignee = currentUser() order by updated DESC", "reporter"),
    ).toBe("reporter = currentUser() order by updated DESC")
  })
  it("adds scope to a query that has none", () => {
    expect(applyJiraScope("issuetype in (任务) order by updated DESC", "assignee")).toBe(
      "issuetype in (任务) AND assignee = currentUser() order by updated DESC",
    )
  })
  it("keeps other clauses, drops the old scope, appends the new one", () => {
    expect(
      applyJiraScope("assignee = currentUser() AND project = X order by updated DESC", "reporter"),
    ).toBe("project = X AND reporter = currentUser() order by updated DESC")
  })
  it("never leaves a dangling connector when the scope clause is first or last", () => {
    expect(applyJiraScope("assignee = currentUser() AND issuetype in (任务)", "reporter")).toBe(
      "issuetype in (任务) AND reporter = currentUser()",
    )
    expect(applyJiraScope("issuetype in (任务) AND assignee = currentUser()", "reporter")).toBe(
      "issuetype in (任务) AND reporter = currentUser()",
    )
  })
  it("handles a query with no ORDER BY", () => {
    expect(applyJiraScope("assignee = currentUser()", "reporter")).toBe("reporter = currentUser()")
  })
  it("preserves a multi-key / uppercase ORDER BY verbatim", () => {
    expect(
      applyJiraScope("assignee = currentUser() ORDER BY status ASC, updated DESC", "reporter"),
    ).toBe("reporter = currentUser() ORDER BY status ASC, updated DESC")
  })
  it("leaves parenthesized (OR) scope clauses in place and appends", () => {
    const base = "(assignee = currentUser() OR reporter = currentUser()) AND issuetype in (任务)"
    expect(applyJiraScope(base, "assignee")).toBe(
      "(assignee = currentUser() OR reporter = currentUser()) AND issuetype in (任务) AND assignee = currentUser()",
    )
  })
  it("does not mutate the input string", () => {
    const base = "assignee = currentUser() order by updated DESC"
    applyJiraScope(base, "reporter")
    expect(base).toBe("assignee = currentUser() order by updated DESC")
  })
})
