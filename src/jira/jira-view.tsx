import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { RefreshCw, Settings2, Clock, ArrowLeft, Inbox, Sparkles, Loader2 } from "lucide-react"
import { analyzeAllTasks } from "./run-jira-analysis"
import { useJiraStore, type JiraTask } from "@/stores/jira-store"
import { useWikiStore } from "@/stores/wiki-store"
import { jiraSearch, jiraIssueTypes, jiraPriorities, JiraApiError, type JiraNamedEntity } from "@/lib/jira-api"
import { isJiraConfigUsable, normalizeJiraServer, type JiraConfig } from "@/lib/jira-config"
import { buildJiraJql, parseJiraJql, type JiraFilterState, type JiraScope } from "@/lib/jira-jql"
import { saveJiraConfig } from "@/lib/project-store"
import { reconcileTasks } from "@/lib/jira-sync"
import { JiraTaskList } from "./jira-task-list"
import { JiraTaskDetail } from "./jira-task-detail"
import { JiraFilterDropdown } from "./jira-filter-dropdown"

type Mode = "list" | "detail" | "history"

// Fallback option lists when the server isn't reachable / has no creds.
// Mirrors the real issue types + priorities on the target Jira instance.
const STATIC_JIRA_TYPES = ["任务", "缺陷", "项目任务", "测试任务", "需求", "Epic", "设计", "风险"]
const STATIC_JIRA_PRIORITIES = ["最高", "高", "较高", "中", "低", "最低"]

// Trailing throttle for persisting filter changes (each checkbox toggle
// rewrites the JQL; one disk write per burst is enough).
const SAVE_THROTTLE_MS = 400

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

  // Batch analysis of every unanalyzed issue on the current list. Runs
  // sequentially (one LLM call at a time) so it matches the poll's pacing.
  const [batchAnalyzing, setBatchAnalyzing] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)
  const batchAnalyze = useCallback(async () => {
    if (batchAnalyzing || config.analysisLevel === "off") return
    setBatchAnalyzing(true)
    setBatchProgress({ done: 0, total: 0 })
    try {
      const result = await analyzeAllTasks(useJiraStore.getState().tasks, (processed, total) =>
        setBatchProgress({ done: processed, total }),
      )
      setError(null)
      if (result.failed > 0) {
        setError(
          t("jira.batchPartial", {
            defaultValue: "AI analysis finished: {{done}} ok, {{failed}} failed, {{skipped}} already analyzed.",
            done: result.done,
            failed: result.failed,
            skipped: result.skipped,
          }),
        )
      }
    } finally {
      setBatchAnalyzing(false)
      setBatchProgress(null)
    }
  }, [batchAnalyzing, config.analysisLevel, t])

  // Pending = on the current list without a cached analysis.
  const pendingAnalysisCount = useMemo(
    () => tasks.filter((task) => !ledger.find((e) => e.key === task.key)?.analysis).length,
    [tasks, ledger],
  )

  // The filter bar edits `config.jql` (persisted — background polling
  // follows). Derive the control state from the authoritative JQL so the
  // store stays the single source of truth.
  const filter = useMemo(() => parseJiraJql(config.jql), [config.jql])

  // Show detail view as soon as a task is selected.
  const detailTask = useJiraStore((s) => s.detailTask)
  const activeMode: Mode = detailTask ? "detail" : mode

  // --- refresh with query-race protection -----------------------------------
  // An in-flight query always finishes by having looked up the LATEST jql:
  // if the filter changed while we awaited, loop and re-query.
  const refreshingRef = useRef(false)
  const lastQueriedJqlRef = useRef<string | null>(null)

  const refresh = useCallback(
    async (opts: { force?: boolean } = {}) => {
      if (refreshingRef.current) return // in-flight loop will pick up new jql
      if (!opts.force && lastQueriedJqlRef.current === useJiraStore.getState().config.jql) return
      refreshingRef.current = true
      setRefreshing(true)
      setError(null)
      try {
        for (;;) {
          const cfg = useJiraStore.getState().config
          if (!cfg.enabled || !isJiraConfigUsable(cfg)) {
            setError(t("jira.needConfig", { defaultValue: "Set Jira server and token in Settings to pull issues." }))
            break
          }
          lastQueriedJqlRef.current = cfg.jql
          const result = await jiraSearch(cfg)
          setTasks(result)
          // Merge into the per-project ledger (dedup / TTL / cached-analysis
          // hydration) WITHOUT firing a batch of LLM calls — those happen
          // on-demand when a specific issue is opened. Best-effort.
          const proj = useWikiStore.getState().project
          if (proj) {
            void reconcileTasks(proj.path, result, cfg.analysisLevel, {
              analyze: false,
              retentionHours: cfg.retentionHours,
            }).catch((err) => console.warn("[jira] refresh reconcile failed:", err))
          }
          if (useJiraStore.getState().config.jql === lastQueriedJqlRef.current) break
        }
      } catch (err) {
        setError(err instanceof JiraApiError ? err.message : String(err))
      } finally {
        refreshingRef.current = false
        setRefreshing(false)
      }
    },
    [setTasks, t],
  )

  // Auto-refresh on mount and whenever the persisted query or credentials change.
  useEffect(() => {
    if (config.enabled && isJiraConfigUsable(config)) {
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.jql, config.enabled, config.server, config.token])

  // --- filter persistence ----------------------------------------------------
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSaveRef = useRef<JiraConfig | null>(null)
  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const cfg = pendingSaveRef.current
    if (cfg) {
      pendingSaveRef.current = null
      void saveJiraConfig(cfg).catch((err) => console.warn("[jira] failed to persist filter:", err))
    }
  }, [])
  // Don't lose a throttled save if the view unmounts inside the window.
  useEffect(() => flushSave, [flushSave])

  const applyFilter = useCallback(
    (over: Partial<Pick<JiraFilterState, "scope" | "types" | "priorities">>) => {
      const cfg = useJiraStore.getState().config
      // Re-parse from the LATEST store value, not the rendered state, so
      // concurrent changes never clobber each other's clauses.
      const next = { ...parseJiraJql(cfg.jql), ...over }
      const jql = buildJiraJql(next)
      if (jql === cfg.jql) return
      const merged = { ...cfg, jql }
      useJiraStore.getState().setConfig(merged)
      pendingSaveRef.current = merged
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(flushSave, SAVE_THROTTLE_MS)
    },
    [flushSave],
  )

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

  // --- dropdown option lists -------------------------------------------------
  // Pull real issue types / priorities once credentials settle; failures fall
  // back to the static lists silently — never throw out of the effect.
  const [serverTypes, setServerTypes] = useState<JiraNamedEntity[]>([])
  const [serverPrios, setServerPrios] = useState<JiraNamedEntity[]>([])
  const [usingFallback, setUsingFallback] = useState(false)
  const credRef = useRef("")
  useEffect(() => {
    const server = normalizeJiraServer(config.server)
    const token = config.token
    if (!config.enabled || !server || !token) {
      setServerTypes([])
      setServerPrios([])
      setUsingFallback(false)
      return
    }
    const key = `${server}|${token}`
    if (credRef.current === key) return
    let cancelled = false
    const cfg = useJiraStore.getState().config
    Promise.all([jiraIssueTypes(cfg).catch(() => null), jiraPriorities(cfg).catch(() => null)]).then(
      ([types, prios]) => {
        if (cancelled) return
        credRef.current = key
        if (types && types.length) setServerTypes(types)
        if (prios && prios.length) setServerPrios(prios)
        setUsingFallback(!types || !types.length || !prios || !prios.length)
      },
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.enabled, config.server, config.token])

  // Union server names with values that actually appear in the fetched list
  // (and the current selection) so checked names are always visible.
  const typeOptions = useMemo(() => {
    const base = serverTypes.length ? serverTypes.map((x) => x.name) : STATIC_JIRA_TYPES
    const union = new Set([...base, ...tasks.map((x) => x.type).filter(Boolean), ...filter.types])
    return Array.from(union).sort((a, b) => a.localeCompare(b, "zh"))
  }, [serverTypes, tasks, filter.types])
  const priorityOptions = useMemo(() => {
    const base = serverPrios.length ? serverPrios.map((x) => x.name) : STATIC_JIRA_PRIORITIES
    const union = new Set([
      ...base,
      ...tasks.map((x) => x.priority).filter(Boolean),
      ...filter.priorities,
    ])
    return Array.from(union).sort((a, b) => a.localeCompare(b, "zh"))
  }, [serverPrios, tasks, filter.priorities])
  const moreLabel = useCallback(
    (extra: number) => t("jira.filterMore", { defaultValue: "+{{count}}", count: extra }),
    [t],
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh({ force: true })}
              disabled={refreshing}
              title={t("jira.refresh", { defaultValue: "Refresh" })}
            >
              <RefreshCw className={`mr-1.5 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              {t("jira.refresh", { defaultValue: "Refresh" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void batchAnalyze()}
              disabled={batchAnalyzing || config.analysisLevel === "off" || tasks.length === 0}
              title={
                config.analysisLevel === "off"
                  ? t("jira.analysisDisabled", { defaultValue: "AI analysis is turned off. Enable an analysis level in Settings → Jira." })
                  : t("jira.analyzeAllHint", { defaultValue: "Analyze every issue on this list that has no AI analysis yet" })
              }
            >
              {batchAnalyzing ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-4 w-4" />
              )}
              {batchAnalyzing && batchProgress
                ? t("jira.batchProgress", {
                    defaultValue: "Analyzing {{done}}/{{total}}",
                    done: batchProgress.done,
                    total: batchProgress.total,
                  })
                : t("jira.analyzeAll", { defaultValue: "AI analyze all" })}
              {!batchAnalyzing && pendingAnalysisCount > 0 &&
                ` (${pendingAnalysisCount})`}
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

      {/* Filter bar (list mode only) — edits the persisted query live. */}
      {activeMode === "list" && mode === "list" && (
        <div className="border-b px-4 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              {(["assignee", "reporter", "all"] as JiraScope[]).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={filter.scope === s ? "secondary" : "ghost"}
                  onClick={() => applyFilter({ scope: s })}
                  title={s === "all" ? t("jira.scopeAllHint", { defaultValue: "No owner restriction — the assignee/reporter clause is removed" }) : undefined}
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
            <JiraFilterDropdown
              label={t("jira.filterType", { defaultValue: "Issue types" })}
              options={typeOptions}
              selected={filter.types}
              allLabel={t("jira.filterTypesAll", { defaultValue: "All types" })}
              moreLabel={moreLabel}
              onChange={(next) => applyFilter({ types: next })}
            />
            <JiraFilterDropdown
              label={t("jira.filterPriority", { defaultValue: "Priorities" })}
              options={priorityOptions}
              selected={filter.priorities}
              allLabel={t("jira.filterPrioritiesAll", { defaultValue: "All priorities" })}
              moreLabel={moreLabel}
              onChange={(next) => applyFilter({ priorities: next })}
            />
          </div>
          {usingFallback && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("jira.optionsFallback", {
                defaultValue:
                  "Showing a built-in option list — connect to your Jira server to load its real issue types and priorities.",
              })}
            </p>
          )}
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

      {/* Body — detail renders as a direct flex child (it owns its own scroll
          region); list/history scroll inside a min-h-0 constrained ScrollArea,
          the same pattern as sources-view. Without min-h-0 the flex item grows
          to its content height and nothing scrolls (ancestors clip overflow). */}
      {activeMode === "detail" ? (
        <JiraTaskDetail onBack={goBack} />
      ) : (
        <ScrollArea className="min-h-0 flex-1 overflow-hidden">
          {mode === "history" ? (
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
            <JiraTaskList tasks={tasks} onOpen={openTask} />
          )}
        </ScrollArea>
      )}

      {!project && activeMode !== "detail" && (
        <div className="border-t px-4 py-2 text-xs text-muted-foreground">
          {t("jira.needProject", { defaultValue: "Open a project before importing issues into the wiki." })}
        </div>
      )}
    </div>
  )
}
