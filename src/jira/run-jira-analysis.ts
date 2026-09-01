import { useJiraStore, type JiraTask } from "@/stores/jira-store"
import { useWikiStore } from "@/stores/wiki-store"
import { analyzeJiraTask } from "@/lib/jira-analyze"
import { jiraComments } from "@/lib/jira-api"
import { upsertLedgerForTask } from "@/lib/jira-sync"
import { saveJiraLedger } from "@/lib/jira-persist"

/**
 * Shared single-issue analysis runner used by both the detail pane's
 * "re-analyze" button and the list toolbar's "analyze all" button.
 * Persists the result to the ledger; never throws (analysis is best-effort).
 *
 * `force` re-runs even when a cached analysis exists; otherwise entries with
 * an existing analysis or cached error are skipped.
 */

// Guard against concurrent single-issue analyses (bounce back + reopen).
const inflight = new Set<string>()

export function isInflight(key: string): boolean {
  return inflight.has(key)
}

export async function runAnalysis(task: JiraTask, force: boolean): Promise<"ok" | "error" | "skipped"> {
  const proj = useWikiStore.getState().project
  if (!proj) return "skipped"
  const level = useJiraStore.getState().config.analysisLevel
  if (level === "off") return "skipped"
  if (inflight.has(task.key)) return "skipped"
  const existing = useJiraStore.getState().ledger.find((e) => e.key === task.key)
  if (!force && (existing?.analysis || existing?.analysisError)) return "skipped"

  inflight.add(task.key)
  try {
    // Comment thread is part of the analysis basis; best-effort — a failed
    // comment fetch analyzes the description alone rather than blocking.
    const comments = await jiraComments(useJiraStore.getState().config, task.key).catch((err) => {
      console.warn(`[jira] comment fetch failed for ${task.key}:`, err)
      return []
    })
    const result = await analyzeJiraTask(task, { analysisLevel: level, comments })
    // Re-read the freshest entry (a poll may have merged meanwhile).
    const fresh = useJiraStore.getState().ledger.find((e) => e.key === task.key)
    const entry = upsertLedgerForTask(task, fresh, useJiraStore.getState().config.retentionHours)
    if ("issues" in result) {
      entry.analysis = result
      entry.analysisError = undefined
      entry.analysisErrorCode = undefined
    } else {
      entry.analysis = undefined
      entry.analysisError = result.reason
      entry.analysisErrorCode = result.code
    }
    entry.lastAnalyzedUpdated = task.updated
    useJiraStore.getState().upsertLedger(entry)
    await saveJiraLedger(proj.path, useJiraStore.getState().ledger).catch((err) =>
      console.warn("[jira] persist analysis failed:", err),
    )
    return "issues" in result ? "ok" : "error"
  } finally {
    inflight.delete(task.key)
  }
}

/** Analyze every task in the list that lacks a cached analysis, in order
 *  (one LLM call at a time — the same pacing as the background poll).
 *  `onProgress` reports (processed, total-to-analyze) after each task.
 *  Returns {done, failed, skipped} counts for the UI. */
export async function analyzeAllTasks(
  tasks: JiraTask[],
  onProgress?: (processed: number, total: number) => void,
): Promise<{
  done: number
  failed: number
  skipped: number
}> {
  let done = 0
  let failed = 0
  let skipped = 0
  // Snapshot the pending set up front so progress denominators stay stable —
  // a poll landing mid-batch must not change what this batch committed to.
  const pending = tasks.filter((task) => {
    const existing = useJiraStore.getState().ledger.find((e) => e.key === task.key)
    return !existing?.analysis
  })
  let processed = 0
  for (const task of pending) {
    const outcome = await runAnalysis(task, true)
    if (outcome === "ok") done++
    else if (outcome === "error") failed++
    else skipped++
    processed++
    onProgress?.(processed, pending.length)
  }
  return { done, failed, skipped }
}
