/**
 * Periodic Jira poller.
 *
 * Mirrors the established `scheduled-index` / `scheduled-import` pattern:
 * a module-level `setInterval` heartbeat that checks a persisted
 * `lastPoll` timestamp against the configured cadence, and a public
 * `startJiraSync` / `stopJiraSync` pair wired from the app lifecycle.
 *
 * Scope: fetch issues, refresh the store's task list, and (per
 * `analysisLevel`) auto-analyze each new/changed issue, caching the result
 * in the ledger. This module does NOT ingest into the wiki — that is the
 * user's explicit choice via the detail pane's "ingest to wiki" button.
 */
import { loadJiraConfig, saveJiraConfig } from "@/lib/project-store"
import { jiraSearch } from "@/lib/jira-api"
import { useJiraStore, type JiraTask, type JiraLedgerEntry } from "@/stores/jira-store"
import { useWikiStore } from "@/stores/wiki-store"
import { analyzeJiraTask } from "@/lib/jira-analyze"
import { isJiraConfigUsable, type JiraConfig } from "@/lib/jira-config"
import { saveJiraLedger, loadJiraLedger } from "@/lib/jira-persist"

let scanTimer: ReturnType<typeof setInterval> | null = null
let polling = false

/** True once the configured cadence has elapsed since the last successful poll. */
export function isJiraPollDue(config: JiraConfig, now = Date.now()): boolean {
  if (!config.enabled) return false
  if (!config.importEnabled || !config.pollEnabled) return false
  if (config.pollIntervalMinutes <= 0) return false
  if (config.lastPoll == null) return true
  const intervalMs = Math.max(1, config.pollIntervalMinutes) * 60 * 1000
  return now - config.lastPoll >= intervalMs
}

/** Merge a fetched task into a ledger entry, carrying forward any cached state. */
export function upsertLedgerForTask(
  task: JiraTask,
  existing?: JiraLedgerEntry,
): JiraLedgerEntry {
  const now = Date.now()
  const resolved = task.resolved
  const retainedUntil =
    resolved && !(existing?.imported ?? false)
      ? (existing?.retainedUntil ?? now + 24 * 3600 * 1000 * 168)
      : null
  return {
    key: task.key,
    imported: existing?.imported ?? false,
    firstSeen: existing?.firstSeen ?? now,
    resolvedAt: resolved ? (existing?.resolvedAt ?? now) : null,
    retainedUntil,
    lastAnalyzedUpdated: existing?.lastAnalyzedUpdated ?? null,
    analysis: existing?.analysis,
    analysisError: existing?.analysisError,
  }
}

/**
 * Reconcile the fetched task list against the ledger and update the store.
 * Re-analyzes issues whose `updated` changed, caches in the ledger, and
 * purges ledger entries that are resolved + never imported + past their
 * retention window (the TTL cleanup the user asked for).
 */
export async function reconcileTasks(
  projectPath: string,
  tasks: JiraTask[],
  analysisLevel: "off" | "basic" | "deep" = "basic",
): Promise<void> {
  const store = useJiraStore.getState()
  let ledger = store.ledger
  if (ledger.length === 0 && projectPath) {
    ledger = await loadJiraLedger(projectPath)
    store.setLedger(ledger)
  }

  const byKey = new Map(ledger.map((entry) => [entry.key, entry]))
  for (const task of tasks) {
    const existing = byKey.get(task.key)
    const entry = upsertLedgerForTask(task, existing)

    // Re-analyze when the issue changed since we last analyzed it (or was
    // never analyzed), unless analysis is off. Best-effort — an analysis
    // failure caches a reason so we don't loop on it every poll.
    if (analysisLevel !== "off" && !entry.analysis && !entry.analysisError) {
      const result = await analyzeJiraTask(task, { analysisLevel })
      if ("issues" in result) entry.analysis = result
      else entry.analysisError = result.reason
      entry.lastAnalyzedUpdated = task.updated
    } else if (
      analysisLevel !== "off" &&
      entry.lastAnalyzedUpdated !== null &&
      task.updated !== entry.lastAnalyzedUpdated
    ) {
      const result = await analyzeJiraTask(task, { analysisLevel })
      if ("issues" in result) {
        entry.analysis = result
        entry.analysisError = undefined
      } else {
        entry.analysis = undefined
        entry.analysisError = result.reason
      }
      entry.lastAnalyzedUpdated = task.updated
    }

    byKey.set(task.key, entry)
  }

  // TTL purge: drop a ledger entry only when it is resolved, never imported,
  // AND its retention window has fully elapsed. Still-open or imported
  // issues are always kept. An entry that fell out of the fetched set but
  // remains within its buffer stays for the history view.
  const now = Date.now()
  const surviving = [...byKey.values()].filter((entry) => {
    const resolvedUnimported = entry.resolvedAt != null && !entry.imported
    if (!resolvedUnimported) return true
    if (entry.retainedUntil == null) return true
    return now < entry.retainedUntil
  })

  store.setTasks(tasks)
  store.setLedger(surviving)
  if (projectPath) {
    await saveJiraLedger(projectPath, surviving).catch((err) =>
      console.warn("[jira-sync] failed to persist ledger:", err),
    )
  }
}

/** One poll: fetch, reconcile, record `lastPoll`. Best effort, never throws. */
export async function jiraPoll(projectPath?: string): Promise<void> {
  if (polling) return
  polling = true
  try {
    const config = await loadJiraConfig()
    if (!config.enabled) return
    if (!isJiraConfigUsable(config)) return
    if (!config.importEnabled) return
    const tasks = await jiraSearch(config, { jql: config.jql })
    const path = projectPath ?? useWikiStore.getState().project?.path
    if (path) {
      await reconcileTasks(path, tasks, config.analysisLevel)
    } else {
      useJiraStore.getState().setTasks(tasks)
    }
    const updated = { ...config, lastPoll: Date.now() }
    useJiraStore.getState().setConfig(updated)
    await saveJiraConfig(updated).catch((err) =>
      console.warn("[jira-sync] failed to save lastPoll:", err),
    )
  } catch (err) {
    console.warn(`[jira-sync] poll failed:`, err)
  } finally {
    polling = false
  }
}

async function maybePoll(): Promise<void> {
  const config = await loadJiraConfig()
  if (!isJiraPollDue(config)) return
  await jiraPoll()
}

export function startJiraSync(): void {
  stopJiraSync()
  void maybePoll().catch((err) =>
    console.error("[jira-sync] initial sweep failed:", err),
  )
  scanTimer = setInterval(() => {
    void maybePoll().catch((err) =>
      console.error("[jira-sync] sweep failed:", err),
    )
  }, 60 * 1000)
}

export function stopJiraSync(): void {
  if (scanTimer) {
    clearInterval(scanTimer)
    scanTimer = null
  }
}
