import { describe, it, expect } from "vitest"
import { jiraTaskMarkdown } from "./jira-ingest"
import type { JiraTask } from "@/stores/jira-store"

const task = (partial: Partial<JiraTask> = {}): JiraTask => ({
  key: "AERDM-7",
  summary: "Handle null user",
  status: "待处理",
  type: "缺陷",
  priority: "高",
  assignee: "luziyu",
  description: "当 user 为 null 时崩溃。",
  updated: 1,
  resolved: false,
  ...partial,
})

describe("jiraTaskMarkdown", () => {
  it("renders a frontmatter-less markdown source document", () => {
    const md = jiraTaskMarkdown(task())
    expect(md).toContain("# Jira AERDM-7: Handle null user")
    expect(md).toContain("**Key**: AERDM-7")
    expect(md).toContain("**Type**: 缺陷")
    expect(md).toContain("**Status**: 待处理")
    expect(md).toContain("**Priority**: 高")
    expect(md).toContain("**Assignee**: luziyu")
    expect(md).toContain("## Original description")
    expect(md).toContain("当 user 为 null 时崩溃。")
  })

  it("appends a suggested description when provided", () => {
    const md = jiraTaskMarkdown(task(), "Rewrite: guard against null.")
    expect(md).toContain("## AI suggested description")
    expect(md).toContain("Rewrite: guard against null.")
  })

  it("omits empty optional fields", () => {
    const md = jiraTaskMarkdown(task({ type: "", priority: "", assignee: null }))
    expect(md).not.toContain("**Type**:")
    expect(md).not.toContain("**Priority**:")
    expect(md).not.toContain("**Assignee**:")
  })

  it("handles a missing description", () => {
    const md = jiraTaskMarkdown(task({ description: null }))
    expect(md).toContain("_(no description)_")
  })
})
