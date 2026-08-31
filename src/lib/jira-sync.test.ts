import { describe, it, expect, vi } from "vitest"
import { upsertLedgerForTask, reconcileTasks, isJiraPollDue } from "./jira-sync"
import { DEFAULT_JIRA_CONFIG, type JiraConfig } from "./jira-config"
import { analyzeJiraTask } from "./jira-analyze"
import { useJiraStore, type JiraTask } from "@/stores/jira-store"

// jira-sync imports project-store (app-state.json via plugin-store) and
// jira-analyze (LLM). For pure unit-testing of the reconciliation logic we
// avoid the poll function itself and exercise upsert + reconcile directly.
// reconcileTasks calls analyzeJiraTask; mock it so tests are deterministic.
vi.mock("./jira-analyze", async () => {
  const actual = await vi.importActual<typeof import("./jira-analyze")>("./jira-analyze")
  return {
    ...actual,
    analyzeJiraTask: vi.fn().mockResolvedValue({
      summary: "ok",
      issues: ["something"],
      suggestedDescription: "rewrite",
      confidence: "medium",
      generatedAt: Date.now(),
    }),
  }
})

// Stub commands/fs so saveJiraLedger is a no-op.
vi.mock("@/commands/fs", async () => {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeFileAtomic: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error("no file")),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    fileExists: vi.fn().mockResolvedValue(false),
  }
})

const task = (partial: Partial<JiraTask>): JiraTask => ({
  key: "AERDM-1",
  summary: "s",
  status: "待处理",
  type: "缺陷",
  priority: "高",
  assignee: "luziyu",
  description: "desc",
  updated: 1000,
  resolved: false,
  ...partial,
})

describe("isJiraPollDue", () => {
  it("false when import disabled or poll disabled", () => {
    expect(isJiraPollDue({ ...DEFAULT_JIRA_CONFIG, pollEnabled: false })).toBe(false)
    expect(isJiraPollDue({ ...DEFAULT_JIRA_CONFIG, importEnabled: false, pollEnabled: true })).toBe(false)
  })
  it("false when the feature master switch is off", () => {
    expect(
      isJiraPollDue({ ...DEFAULT_JIRA_CONFIG, enabled: false, importEnabled: true, pollEnabled: true }),
    ).toBe(false)
  })
  it("true when never polled", () => {
    expect(isJiraPollDue({ ...DEFAULT_JIRA_CONFIG, importEnabled: true, pollEnabled: true })).toBe(true)
  })
  it("true after interval elapses", () => {
    const config: JiraConfig = { ...DEFAULT_JIRA_CONFIG, importEnabled: true, pollEnabled: true, pollIntervalMinutes: 1, lastPoll: 0 }
    expect(isJiraPollDue(config, 60 * 1000 + 1)).toBe(true)
    // At exactly the interval it is already due; one ms before it is not.
    expect(isJiraPollDue(config, 59_999)).toBe(false)
  })
})

describe("upsertLedgerForTask", () => {
  it("creates an open entry with no retention", () => {
    const entry = upsertLedgerForTask(task({}))
    expect(entry.key).toBe("AERDM-1")
    expect(entry.imported).toBe(false)
    expect(entry.resolvedAt).toBe(null)
    expect(entry.retainedUntil).toBe(null)
  })
  it("sets retainedUntil for a resolved-unimported issue", () => {
    const entry = upsertLedgerForTask(task({ resolved: true }))
    expect(entry.resolvedAt).not.toBe(null)
    expect(entry.retainedUntil).not.toBe(null)
  })
  it("does not retain an imported issue", () => {
    const existing = { key: "AERDM-1", imported: true, firstSeen: 1, resolvedAt: null, retainedUntil: null, lastAnalyzedUpdated: null }
    const entry = upsertLedgerForTask(task({ resolved: true }), existing)
    expect(entry.retainedUntil).toBe(null)
    expect(entry.imported).toBe(true)
  })
})

describe("reconcileTasks", () => {
  it("populates tasks and ledger, caching analysis", async () => {
    useJiraStore.setState({ tasks: [], ledger: [], detailTask: null })
    await reconcileTasks("C:\\proj", [task({ updated: 5 })], "basic")
    const state = useJiraStore.getState()
    expect(state.tasks).toHaveLength(1)
    expect(state.ledger).toHaveLength(1)
    expect(state.ledger[0].analysis).toBeDefined()
  })

  it("purges resolved-unimported entries past retention", async () => {
    const past = Date.now() - 10 * 24 * 3600 * 1000
    useJiraStore.setState({
      tasks: [],
      ledger: [
        {
          key: "X-1",
          imported: false,
          firstSeen: past,
          resolvedAt: past,
          retainedUntil: past,
          lastAnalyzedUpdated: null,
        },
      ],
      detailTask: null,
    })
    // fetch only Y-1 (an open issue) so X-1 drops out of the active set
    await reconcileTasks("C:\\proj", [task({ key: "Y-1", updated: 1 })], "off")
    const keys = useJiraStore.getState().ledger.map((e) => e.key)
    expect(keys).not.toContain("X-1")
    expect(keys).toContain("Y-1")
  })

  it("analyze:false merges the ledger without invoking the LLM", async () => {
    const mock = analyzeJiraTask as ReturnType<typeof vi.fn>
    mock.mockClear()
    useJiraStore.setState({ tasks: [], ledger: [], detailTask: null })
    await reconcileTasks("C:\\proj", [task({ key: "A-1", updated: 5 })], "basic", { analyze: false })
    const state = useJiraStore.getState()
    expect(state.tasks).toHaveLength(1)
    expect(state.ledger).toHaveLength(1)
    expect(state.ledger[0].analysis).toBeUndefined()
    expect(mock).not.toHaveBeenCalled()
  })

  it("forceRetryErrors re-runs analysis on a sticky cached error; default does not", async () => {
    const mock = analyzeJiraTask as ReturnType<typeof vi.fn>
    const seedLedger = () =>
      useJiraStore.setState({
        tasks: [],
        detailTask: null,
        ledger: [
          {
            key: "E-1",
            imported: false,
            firstSeen: 1,
            resolvedAt: null,
            retainedUntil: null,
            lastAnalyzedUpdated: 7,
            analysisError: "boom",
          },
        ],
      })
    // `updated` is unchanged (7), so a normal reconcile must NOT retry.
    mock.mockClear()
    seedLedger()
    await reconcileTasks("C:\\proj", [task({ key: "E-1", updated: 7 })], "basic")
    expect(mock).not.toHaveBeenCalled()
    // forceRetryErrors retries despite the unchanged timestamp.
    mock.mockClear()
    seedLedger()
    await reconcileTasks("C:\\proj", [task({ key: "E-1", updated: 7 })], "basic", {
      forceRetryErrors: true,
    })
    expect(mock).toHaveBeenCalledTimes(1)
  })
})

describe("upsertLedgerForTask retention hours", () => {
  it("treats retentionHours as HOURS (regression: was misread as days)", () => {
    const before = Date.now()
    const entry = upsertLedgerForTask(task({ key: "R-1", resolved: true }), undefined, 2)
    const ms = (entry.retainedUntil as number) - before
    expect(ms).toBeGreaterThanOrEqual(2 * 3_600_000 - 50)
    expect(ms).toBeLessThanOrEqual(2 * 3_600_000 + 500)
  })
})
