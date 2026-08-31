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
import { isJiraConfigUsable, DEFAULT_JIRA_CONFIG, type JiraConfig } from "@/lib/jira-config"
import { saveJiraLedger, loadJiraLedger } from "@/lib/jira-persist"

let scanTimer: ReturnType<typeof setInterval> | null = null
let polling = false
// Single-flight guard so a view refresh + a background poll never interleave
// their ledger writes (last-writer would otherwise clobber the other).
let reconciling = false

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
  retentionHours: number = DEFAULT_JIRA_CONFIG.retentionHours,
): JiraLedgerEntry {
  const now = Date.now()
  const resolved = task.resolved
  const retainedUntil =
    resolved && !(existing?.imported ?? false)
      // retention is configured in HOURS (was misread as days, ~168× too long).
      ? (existing?.retainedUntil ?? now + retentionHours * 3_600_000)
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
export interface ReconcileOptions {
  /** Whether to run the LLM analysis passes at all. Default true (poll's behavior). */
  analyze?: boolean
  /** Re-run analysis for entries with a cached error even if `updated` is unchanged. */
  forceRetryErrors?: boolean
  /** Retention window in HOURS for resolved-unimported entries. */
  retentionHours?: number
}

export async function reconcileTasks(
  projectPath: string,
  tasks: JiraTask[],
  analysisLevel: "off" | "basic" | "deep" = "basic",
  options: ReconcileOptions = {},
): Promise<void> {
  // Single-flight: if a poll's long batch analysis is in progress, a view
  // refresh must not interleave and clobber it. The refresh already ran
  // setTasks, so skipping the merge here is harmless.
  if (reconciling) return
  reconciling = true
  try {
    const store = useJiraStore.getState()
    let ledger = store.ledger
    if (ledger.length === 0 && projectPath) {
      ledger = await loadJiraLedger(projectPath)
      store.setLedger(ledger)
    }

    const retentionHours = options.retentionHours ?? DEFAULT_JIRA_CONFIG.retentionHours
    const byKey = new Map(ledger.map((entry) => [entry.key, entry]))
    for (const task of tasks) {
      const existing = byKey.get(task.key)
      const entry = upsertLedgerForTask(task, existing, retentionHours)

      // Re-analyze when: never analyzed (fresh), or changed since last analysis,
      // or (manual refresh) a sticky error with forceRetryErrors. Skipped
      // entirely when analysis is off or the caller passed analyze:false.
      const fresh = !entry.analysis && !entry.analysisError
      const changed =
        entry.lastAnalyzedUpdated !== null && task.updated !== entry.lastAnalyzedUpdated
      const retryError = options.forceRetryErrors === true && Boolean(entry.analysisError)
      if (analysisLevel !== "off" && options.analyze !== false && (fresh || changed || retryError)) {
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

    // R1 mitigation: a detail-open analysis may have written to the store while
    // we were awaiting the LLM above. Re-read the latest store and overlay any
    // per-key analysis we didn't produce ourselves, so we never clobber it.
    const latestByKey = new Map(useJiraStore.getState().ledger.map((e) => [e.key, e]))
    const merged = surviving.map((entry) => {
      const latest = latestByKey.get(entry.key)
      if (!latest) return entry
      let out = entry
      if (latest.imported && !out.imported) out = { ...out, imported: true }
      if (!out.analysis && latest.analysis) {
        out = { ...out, analysis: latest.analysis, analysisError: undefined, lastAnalyzedUpdated: latest.lastAnalyzedUpdated }
      } else if (!out.analysisError && !out.analysis && latest.analysisError) {
        out = { ...out, analysisError: latest.analysisError, lastAnalyzedUpdated: latest.lastAnalyzedUpdated }
      }
      return out
    })

    store.setTasks(tasks)
    store.setLedger(merged)
    if (projectPath) {
      await saveJiraLedger(projectPath, merged).catch((err) =>
        console.warn("[jira-sync] failed to persist ledger:", err),
      )
    }
  } finally {
    reconciling = false
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
      await reconcileTasks(path, tasks, config.analysisLevel, {
        retentionHours: config.retentionHours,
      })
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
