import { describe, it, expect } from "vitest"
import { summarizeSelection } from "./jira-filter-dropdown"

const more = (n: number) => `+${n}`

describe("summarizeSelection", () => {
  it("shows the all-label when nothing is selected", () => {
    expect(summarizeSelection([], "全部类型", more)).toBe("全部类型")
  })
  it("shows the bare name for a single selection", () => {
    expect(summarizeSelection(["缺陷"], "全部类型", more)).toBe("缺陷")
  })
  it("shows the first name plus the overflow count for many", () => {
    expect(summarizeSelection(["缺陷", "任务", "需求"], "全部类型", more)).toBe("缺陷 +2")
  })
})
