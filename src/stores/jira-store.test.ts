import { describe, it, expect, beforeEach } from "vitest"
import { useJiraStore, type JiraLedgerEntry } from "./jira-store"
import type { JiraAnalysis } from "@/lib/jira-analyze"

const analysis = (over: Partial<JiraAnalysis> = {}): JiraAnalysis => ({
  summary: "ok",
  issues: ["a"],
  suggestedDescription: "",
  confidence: "high",
  generatedAt: 1,
  ...over,
})

const entry = (over: Partial<JiraLedgerEntry> = {}): JiraLedgerEntry => ({
  key: "AERDM-1",
  imported: false,
  firstSeen: 1,
  resolvedAt: null,
  retainedUntil: null,
  lastAnalyzedUpdated: null,
  ...over,
})

const ledgerEntry = (key = "AERDM-1") =>
  useJiraStore.getState().ledger.find((item) => item.key === key)

beforeEach(() => {
  useJiraStore.setState({ ledger: [] })
})

describe("jira-store upsertLedger", () => {
  it("inserts a new entry when the key is unknown", () => {
    useJiraStore.getState().upsertLedger(entry({ analysis: analysis() }))
    expect(ledgerEntry()?.analysis?.summary).toBe("ok")
  })

  it("clears a stale cached error when a fresh successful analysis arrives", () => {
    useJiraStore.getState().setLedger([
      entry({ analysisError: "The model returned an empty response.", analysisErrorCode: "empty" }),
    ])
    // Detail success path: analysis set, error fields explicitly cleared.
    useJiraStore.getState().upsertLedger(entry({ analysis: analysis(), analysisError: undefined, analysisErrorCode: undefined }))
    const merged = ledgerEntry()
    expect(merged?.analysis?.summary).toBe("ok")
    // Regression: `entry.analysisError ?? item.analysisError` kept the old
    // error forever, re-polluting the list badge after a successful retry.
    expect(merged?.analysisError).toBeUndefined()
    expect(merged?.analysisErrorCode).toBeUndefined()
  })

  it("keeps a usable cached analysis when a later re-analysis fails", () => {
    useJiraStore.getState().setLedger([entry({ analysis: analysis({ summary: "good" }) })])
    useJiraStore.getState().upsertLedger(entry({ analysis: undefined, analysisError: "boom", analysisErrorCode: "empty" }))
    const merged = ledgerEntry()
    expect(merged?.analysis?.summary).toBe("good")
    expect(merged?.analysisError).toBe("boom")
  })

  it("preserves existing analysis and error when the upsert carries neither", () => {
    useJiraStore.getState().setLedger([
      entry({ analysisError: "boom", analysisErrorCode: "noJson", imported: true }),
    ])
    // Plain reconcile merge (upsertLedgerForTask) copies cached state; a bare
    // entry with undefined fields must not wipe it.
    useJiraStore.getState().upsertLedger(entry())
    const merged = ledgerEntry()
    expect(merged?.analysisError).toBe("boom")
    expect(merged?.analysisErrorCode).toBe("noJson")
    expect(merged?.imported).toBe(true)
  })
})
