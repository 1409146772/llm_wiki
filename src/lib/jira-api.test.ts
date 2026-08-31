import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  mapJiraIssue,
  jiraSearch,
  jiraTestConnection,
  jiraIssueTypes,
  jiraPriorities,
  JiraApiError,
  __testing,
} from "./jira-api"
import { DEFAULT_JIRA_CONFIG } from "./jira-config"

const { jiraBase } = __testing

const cfg = { ...DEFAULT_JIRA_CONFIG, server: "https://jira.cvte.com/", token: "pat-123" }

const rawIssue = {
  key: "AERDM-123",
  fields: {
    summary: "[WB101] Fix flaky login",
    status: { name: "待处理" },
    issuetype: { name: "缺陷" },
    priority: { name: "高" },
    assignee: { displayName: "李四" },
    description:
      "用户登录时偶发失败，需要排查一下。\n1. 复现步骤\n2. 期望",
    updated: "2026-08-29T10:00:00.000+0800",
  },
}

// Mock the fetch provider so we don't need a live Jira/network. The module
// under test imports getHttpFetch from tauri-fetch; swap that for a stub.
const mockHttpFetch = vi.fn()
vi.mock("./tauri-fetch", async () => {
  const actual = await vi.importActual<typeof import("./tauri-fetch")>("./tauri-fetch")
  return {
    ...actual,
    getHttpFetch: () => Promise.resolve(mockHttpFetch as unknown as typeof globalThis.fetch),
  }
})

beforeEach(() => {
  mockHttpFetch.mockReset()
})

describe("jiraBase", () => {
  it("strips trailing slash and normalizes to https", () => {
    expect(jiraBase(cfg)).toBe("https://jira.cvte.com")
    expect(jiraBase({ ...cfg, server: "jira.cvte.com " })).toBe("https://jira.cvte.com")
  })
})

describe("mapJiraIssue", () => {
  it("maps a raw issue to JiraTask", () => {
    const task = mapJiraIssue(rawIssue)
    expect(task).toMatchObject({
      key: "AERDM-123",
      summary: "[WB101] Fix flaky login",
      status: "待处理",
      type: "缺陷",
      priority: "高",
      assignee: "李四",
    })
    expect(task?.description).toContain("复现步骤")
    expect(task?.resolved).toBe(false)
  })

  it("treats terminal status names as resolved", () => {
    const t1 = mapJiraIssue({ key: "X-1", fields: { status: { name: "已关闭" } } })
    expect(t1?.resolved).toBe(true)
    const t2 = mapJiraIssue({ key: "X-2", fields: { status: { name: "Done" } } })
    expect(t2?.resolved).toBe(true)
    const t3 = mapJiraIssue({ key: "X-3", fields: { status: { name: "进行中" } } })
    expect(t3?.resolved).toBe(false)
  })

  it("handles Adf description and missing fields", () => {
    const task = mapJiraIssue({
      key: "AERDM-444",
      fields: {
        summary: "ADF task",
        status: { name: "打开" },
        description: [
          { type: "paragraph", content: [{ type: "text", text: "Line one " }, { type: "text", text: "Line two" }] },
          { type: "paragraph", content: [{ type: "text", text: "Bullet" }] },
        ],
      },
    })
    expect(task?.description).toContain("Line one")
    expect(task?.resolved).toBe(false)
    expect(task?.type).toBe("")
    // No assignee -> null
    expect(task?.assignee).toBe(null)
  })

  it("returns null for missing key", () => {
    expect(mapJiraIssue({ fields: {} })).toBe(null)
    expect(mapJiraIssue(null)).toBe(null)
  })
})

describe("jiraSearch", () => {
  it("fetches the search endpoint with an Authorization header", async () => {
    mockHttpFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ issues: [rawIssue] }),
    })
    const tasks = await jiraSearch(cfg, { jql: "issuetype in (缺陷)" })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].key).toBe("AERDM-123")
    const [url, init] = mockHttpFetch.mock.calls[0]
    expect(String(url)).toContain("/rest/api/2/search")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pat-123")
  })

  it("throws JiraApiError on 401", async () => {
    mockHttpFetch.mockResolvedValue({ ok: false, status: 401, text: async () => "Unauthorized" })
    await expect(jiraSearch(cfg)).rejects.toBeInstanceOf(JiraApiError)
  })
})

describe("jiraTestConnection", () => {
  it("returns ok when myself resolves", async () => {
    mockHttpFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ displayName: "luziyu" }),
    })
    const res = await jiraTestConnection(cfg)
    expect(res.ok).toBe(true)
    expect(res.message).toContain("luziyu")
  })
})

describe("jiraIssueTypes", () => {
  it("maps the bare array and filters out subtasks", async () => {
    mockHttpFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: "3", name: "任务", subtask: false },
        { id: "10602", name: "子任务", subtask: true },
        { id: "10601", name: "缺陷", subtask: false },
      ],
    })
    const types = await jiraIssueTypes(cfg)
    expect(types.map((x) => x.name)).toEqual(["任务", "缺陷"])
    expect(String(mockHttpFetch.mock.calls[0][0])).toContain("/rest/api/2/issuetype")
  })
})

describe("jiraPriorities", () => {
  it("accepts a bare array (this Server)", async () => {
    mockHttpFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: "1", name: "最高" },
        { id: "3", name: "中" },
      ],
    })
    const prios = await jiraPriorities(cfg)
    expect(prios.map((x) => x.name)).toEqual(["最高", "中"])
  })
  it("accepts the { priorities: [...] } wrapper (Cloud docs)", async () => {
    mockHttpFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ priorities: [{ id: "2", name: "高" }] }),
    })
    const prios = await jiraPriorities(cfg)
    expect(prios.map((x) => x.name)).toEqual(["高"])
  })
})
