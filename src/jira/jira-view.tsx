import { useState, useEffect, useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { RefreshCw, Settings2, Clock, ArrowLeft, Inbox } from "lucide-react"
import { useJiraStore, type JiraTask } from "@/stores/jira-store"
import { useWikiStore } from "@/stores/wiki-store"
import { jiraSearch, JiraApiError } from "@/lib/jira-api"
import { isJiraConfigUsable } from "@/lib/jira-config"
import { applyJiraScope, type JiraScope } from "@/lib/jira-jql"
import { reconcileTasks } from "@/lib/jira-sync"
import { JiraTaskList } from "./jira-task-list"
import { JiraTaskDetail } from "./jira-task-detail"

type Mode = "list" | "detail" | "history"

const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

export function JiraView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const config = useJiraStore((s) => s.config)
  const tasks = useJiraStore((s) => s.tasks)
  const setTasks = useJiraStore((s) => s.setTasks)
  const ledger = useJiraStore((s) => s.ledger)

  const [mode, setMode] = useState<Mode>("list")
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Query-level scope (re-queries Jira) + local list filters (no re-query).
  const [scope, setScope] = useState<JiraScope>("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [priorityFilter, setPriorityFilter] = useState("all")

  // Show detail view as soon as a task is selected.
  const detailTask = useJiraStore((s) => s.detailTask)
  const activeMode: Mode = detailTask ? "detail" : mode

  const refresh = useCallback(async () => {
    if (refreshing) return
    setError(null)
    setRefreshing(true)
    try {
      if (!config.enabled) {
        setError(t("jira.needConfig", { defaultValue: "Set Jira server and token in Settings to pull issues." }))
        return
      }
      if (!isJiraConfigUsable(config)) {
        setError(t("jira.needConfig", { defaultValue: "Set Jira server and token in Settings to pull issues." }))
        return
      }
      const result = await jiraSearch(config, { jql: applyJiraScope(config.jql, scope) })
      setTasks(result)
      // Merge into the per-project ledger (dedup / TTL / cached-analysis
      // hydration) WITHOUT firing a batch of LLM calls — those happen
      // on-demand when a specific issue is opened. Best-effort.
      const proj = useWikiStore.getState().project
      if (proj) {
        void reconcileTasks(proj.path, result, config.analysisLevel, {
          analyze: false,
          retentionHours: config.retentionHours,
        }).catch((err) => console.warn("[jira] refresh reconcile failed:", err))
      }
    } catch (err) {
      setError(err instanceof JiraApiError ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }, [refreshing, config, setTasks, t, scope])

  // Auto-refresh on mount and whenever the scope changes.
  useEffect(() => {
    if (config.enabled && isJiraConfigUsable(config)) {
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const onScopeChange = useCallback((s: JiraScope) => {
    setScope(s)
    // New query → previous local filters may no longer apply; reset them.
    setTypeFilter("all")
    setPriorityFilter("all")
  }, [])

  const openTask = useCallback((task: JiraTask) => {
    useJiraStore.getState().setDetailTask(task)
  }, [])

  const goBack = useCallback(() => {
    useJiraStore.getState().setDetailTask(null)
    setMode("list")
  }, [])

  const goToSettings = useCallback(() => {
    useWikiStore.getState().setActiveView("settings")
  }, [])

  // Filter options derived from the fetched list (local filtering only).
  const typeOptions = useMemo(
    () => Array.from(new Set(tasks.map((x) => x.type).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh")),
    [tasks],
  )
  const priorityOptions = useMemo(
    () => Array.from(new Set(tasks.map((x) => x.priority).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh")),
    [tasks],
  )
  const visibleTasks = useMemo(
    () =>
      tasks.filter(
        (x) =>
          (typeFilter === "all" || x.type === typeFilter) &&
          (priorityFilter === "all" || x.priority === priorityFilter),
      ),
    [tasks, typeFilter, priorityFilter],
  )

  // History view: filter ledger to resolved-unimported entries within
  // retention (they are the "past but not discarded" records).
  const historyEntries = ledger.filter((entry) => entry.resolvedAt !== null && !entry.imported)

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        {activeMode === "detail" ? (
          <Button variant="ghost" size="sm" onClick={goBack}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            {t("jira.back", { defaultValue: "All issues" })}
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing} title={t("jira.refresh", { defaultValue: "Refresh" })}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              {t("jira.refresh", { defaultValue: "Refresh" })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMode(mode === "history" ? "list" : "history")}
              title={t("jira.history", { defaultValue: "History" })}
            >
              <Clock className="mr-1.5 h-4 w-4" />
              {t("jira.history", { defaultValue: "History" })}
              {mode === "history" && ` (${historyEntries.length})`}
            </Button>
            <div className="flex-1" />
            <Button variant="ghost" size="icon" onClick={goToSettings} title={t("jira.config", { defaultValue: "Open Jira settings" })}>
              <Settings2 className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>

      {/* Filter bar (list mode only) */}
      {activeMode === "list" && mode === "list" && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <div className="flex items-center gap-1">
            {(["assignee", "reporter", "all"] as JiraScope[]).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={scope === s ? "secondary" : "ghost"}
                onClick={() => onScopeChange(s)}
                title={s === "all" ? t("jira.scopeAllHint", { defaultValue: "Run the query as written in Settings" }) : undefined}
              >
                {s === "assignee"
                  ? t("jira.scopeAssignedToMe", { defaultValue: "Assigned to me" })
                  : s === "reporter"
                    ? t("jira.scopeReportedByMe", { defaultValue: "Reported by me" })
                    : t("jira.scopeAll", { defaultValue: "All" })}
              </Button>
            ))}
          </div>
          <div className="flex-1" />
          <select
            aria-label={t("jira.filterType", { defaultValue: "Filter by type" })}
            className={SELECT_CLASS}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="all">{t("jira.filterType", { defaultValue: "Filter by type" })}</option>
            {typeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <select
            aria-label={t("jira.filterPriority", { defaultValue: "Filter by priority" })}
            className={SELECT_CLASS}
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
          >
            <option value="all">{t("jira.filterPriority", { defaultValue: "Filter by priority" })}</option>
            {priorityOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Error / not configured */}
      {error && (
        <div className="flex items-center justify-between gap-2 border-b bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="flex items-center gap-1.5">{error}</span>
          <Button variant="ghost" size="sm" onClick={goToSettings}>
            {t("jira.goToSettings", { defaultValue: "Settings" })}
          </Button>
        </div>
      )}

      {/* Body */}
      <ScrollArea className="flex-1">
        {activeMode === "detail" ? (
          <JiraTaskDetail onBack={goBack} />
        ) : mode === "history" ? (
          historyEntries.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <Inbox className="mb-2 h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                {t("jira.historyEmpty", { defaultValue: "No resolved-unimported issues in retention." })}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {historyEntries.map((entry) => (
                <li key={entry.key} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <span className="font-mono text-xs text-muted-foreground">{entry.key}</span>
                    <span className="ml-2 truncate">{t("jira.historyEntry", { defaultValue: "resolved, waiting {{hours}}h retention", hours: Math.max(0, Math.ceil(((entry.retainedUntil ?? Date.now()) - Date.now()) / 3600000)) })}</span>
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : (
          <JiraTaskList tasks={visibleTasks} onOpen={openTask} />
        )}
      </ScrollArea>

      {!project && activeMode !== "detail" && (
        <div className="border-t px-4 py-2 text-xs text-muted-foreground">
          {t("jira.needProject", { defaultValue: "Open a project before importing issues into the wiki." })}
        </div>
      )}
    </div>
  )
}
