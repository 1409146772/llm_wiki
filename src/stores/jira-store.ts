import { create } from "zustand"
import type { JiraAnalysis, JiraAnalysisErrorCode } from "@/lib/jira-analyze"
import { DEFAULT_JIRA_CONFIG, type JiraConfig } from "@/lib/jira-config"

/**
 * A Jira issue as fetched over REST and shown in the Jira view. This is a
 * UI-facing projection of the API response — not a full issue object.
 */
export interface JiraTask {
  key: string
  summary: string
  status: string
  /** Display name of the issue type, e.g. "缺陷". */
  type: string
  priority: string
  assignee: string | null
  description: string | null
  /** Last-updated timestamp (ms) from Jira. */
  updated: number
  /** True when the status name is a resolved/closed/Done/Cancelled state. */
  resolved: boolean
}

/**
 * A ledger record for a single issue across the app's lifetime. Tracks
 * whether the user chose to import it into the wiki, caches the AI
 * analysis, and the retention bookkeeping that lets resolved-but-unimported
 * issues expire out of the history view.
 */
export interface JiraLedgerEntry {
  key: string
  /** True once the user imported this issue into the wiki; it is then kept. */
  imported: boolean
  /** Cached AI analysis (or undefined until analyzed). */
  analysis?: JiraAnalysis
  /** Cached analysis-unavailable reason, so we don't re-analyze in a loop. */
  analysisError?: string
  /** Structured error code for localized rendering. Old ledger entries lack
   *  it — the UI then falls back to showing `analysisError` verbatim. */
  analysisErrorCode?: JiraAnalysisErrorCode
  /** First time we saw this issue (ms). */
  firstSeen: number
  /** When the issue became resolved in Jira, or null if still open. */
  resolvedAt: number | null
  /** Absolute timestamp after which a resolved+unimported issue may be purged. */
  retainedUntil: number | null
  /** Last issue `updated` we analyzed, to avoid re-running on every poll. */
  lastAnalyzedUpdated: number | null
}

interface JiraState {
  /** Currently effective, normalized config (mirror of app-state). */
  config: JiraConfig
  /** Issues shown on the list page (only from the last search). */
  tasks: JiraTask[]
  /** Per-issue ledger (cache of persisted `.llm-wiki/jira.json`). */
  ledger: JiraLedgerEntry[]
  /** The issue currently opened in the detail pane. */
  detailTask: JiraTask | null
  setConfig: (config: JiraConfig) => void
  setTasks: (tasks: JiraTask[]) => void
  setLedger: (ledger: JiraLedgerEntry[]) => void
  setDetailTask: (task: JiraTask | null) => void
  /** Upsert a ledger entry (by key), preserving `imported` and analysis. */
  upsertLedger: (entry: JiraLedgerEntry) => void
  /** Mark an issue as imported (never auto-purged afterwards). */
  markImported: (key: string) => void
}

export const useJiraStore = create<JiraState>((set) => ({
  config: DEFAULT_JIRA_CONFIG,
  tasks: [],
  ledger: [],
  detailTask: null,

  setConfig: (config) => set({ config }),
  setTasks: (tasks) => set({ tasks }),
  setLedger: (ledger) => set({ ledger }),
  setDetailTask: (detailTask) => set({ detailTask }),

  upsertLedger: (entry) =>
    set((state) => {
      const existing = state.ledger.find((item) => item.key === entry.key)
      if (!existing) return { ledger: [entry, ...state.ledger] }
      return {
        ledger: state.ledger.map((item) =>
          item.key === entry.key
            ? {
                ...item,
                // Preserve imported flag — it is user intent and must not be
                // reset by a later poll.
                imported: item.imported || entry.imported,
                analysis: entry.analysis ?? item.analysis,
                analysisError: entry.analysisError ?? item.analysisError,
                analysisErrorCode: entry.analysisErrorCode ?? item.analysisErrorCode,
                resolvedAt: entry.resolvedAt ?? item.resolvedAt,
                retainedUntil: entry.retainedUntil ?? item.retainedUntil,
                lastAnalyzedUpdated: entry.lastAnalyzedUpdated ?? item.lastAnalyzedUpdated,
              }
            : item,
        ),
      }
    }),

  markImported: (key) =>
    set((state) => ({
      ledger: state.ledger.map((item) =>
        item.key === key ? { ...item, imported: true } : item,
      ),
    })),
}))

/**
 * Compute whether an issue should be considered resolved by its status name.
 * Jira status names are locale-dependent; cover the common closed/terminal
 * set plus a couple of CVTE-observed variants.
 */
const RESOLVED_STATUS = new Set([
  "closed", "done", "resolved", "已完成", "关闭", "已关闭", "已解决",
  "cancelled", "canceled", "取消", "已取消",
])

export function isResolvedStatus(status: string): boolean {
  const s = status.trim().toLowerCase()
  if (!s) return false
  if (RESOLVED_STATUS.has(s)) return true
  // Also treat "Done"-style suffixes (e.g. "Done / 完成") as resolved.
  return /^done\b|已完成$|^关闭$|已关闭|已解决/.test(s)
}
