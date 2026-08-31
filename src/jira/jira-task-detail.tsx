import { useState, useEffect, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { ArrowLeft, BookUp, CheckCircle2, CircleAlert, Loader2, RotateCw } from "lucide-react"
import { useJiraStore, type JiraTask } from "@/stores/jira-store"
import { useWikiStore } from "@/stores/wiki-store"
import { analyzeJiraTask, isJiraAnalysis } from "@/lib/jira-analyze"
import { upsertLedgerForTask } from "@/lib/jira-sync"
import { saveJiraLedger } from "@/lib/jira-persist"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { jiraTaskToWiki } from "./jira-ingest"

interface Props {
  onBack: () => void
}

// Guard against concurrent single-issue analyses (bounce back + reopen).
const inflight = new Set<string>()

export function JiraTaskDetail({ onBack }: Props) {
  const { t } = useTranslation()
  const detailTask = useJiraStore((s) => s.detailTask)
  const ledger = useJiraStore((s) => s.ledger)
  const config = useJiraStore((s) => s.config)
  const project = useWikiStore((s) => s.project)

  const [ingesting, setIngesting] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  // Analyze one issue on demand and persist to the ledger. Never throws
  // (analyzeJiraTask is best-effort). `force` retries a cached error.
  const runAnalysis = useCallback(async (task: JiraTask, force: boolean) => {
    const proj = useWikiStore.getState().project
    if (!proj) return
    const level = useJiraStore.getState().config.analysisLevel
    if (level === "off") return
    if (inflight.has(task.key)) return
    const existing = useJiraStore.getState().ledger.find((e) => e.key === task.key)
    if (!force && (existing?.analysis || existing?.analysisError)) return

    inflight.add(task.key)
    setAnalyzing(true)
    try {
      const result = await analyzeJiraTask(task, { analysisLevel: level })
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
    } finally {
      inflight.delete(task.key)
      setAnalyzing(false)
    }
  }, [])

  // When a detail opens without a cached result, kick off one analysis pass.
  const taskKey = detailTask?.key
  useEffect(() => {
    if (!detailTask || !project || config.analysisLevel === "off") return
    const entry = useJiraStore.getState().ledger.find((e) => e.key === detailTask.key)
    if (entry?.analysis || entry?.analysisError) return
    void runAnalysis(detailTask, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskKey, project, config.analysisLevel])

  if (!detailTask) return null

  const entry = ledger.find((item) => item.key === detailTask.key)
  const analysis = entry?.analysis
  const analysisError = entry?.analysisError
  const analysisErrorCode = entry?.analysisErrorCode
  // Known codes localize; free-form transport errors (code "error", or old
  // ledger rows without a code) show the stored English string verbatim.
  const analysisErrorText =
    analysisErrorCode && analysisErrorCode !== "error"
      ? t(`jira.analysisError.${analysisErrorCode}`, { defaultValue: analysisError })
      : analysisError
  const imported = Boolean(entry?.imported)
  const analysisOff = config.analysisLevel === "off"

  const handleIngest = async () => {
    if (!project || ingesting) return
    setIngesting(true)
    setMessage(null)
    try {
      const llmConfig = useWikiStore.getState().llmConfig
      const dest = await jiraTaskToWiki(project, detailTask, llmConfig, analysis?.suggestedDescription)
      useJiraStore.getState().markImported(detailTask.key)
      await refreshProjectFileTree(project.path, { projectId: project.id, bumpDataVersion: true })
      setMessage({ ok: true, text: t("jira.ingested", { defaultValue: "Imported to wiki: {{path}}", path: dest }) })
    } catch (err) {
      setMessage({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIngesting(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="icon" onClick={onBack} title={t("jira.back", { defaultValue: "Back" })}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">
            {detailTask.key}: {detailTask.summary}
          </h2>
          <p className="text-xs text-muted-foreground">
            {detailTask.type}
            {detailTask.priority && ` · ${detailTask.priority}`}
            {detailTask.assignee && ` · ${detailTask.assignee}`}
            {detailTask.status && ` · ${detailTask.status}`}
          </p>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-6 px-4 py-4">
          {/* Description */}
          <section>
            <h3 className="mb-2 text-sm font-medium">
              {t("jira.description", { defaultValue: "Description" })}
            </h3>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {detailTask.description || t("jira.noDescription", { defaultValue: "No description." })}
            </p>
          </section>

          {/* AI analysis */}
          <section>
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              <CheckCircle2 className="h-4 w-4 text-blue-500" />
              {t("jira.analysis", { defaultValue: "AI analysis" })}
            </h3>

            {analysis && isJiraAnalysis(analysis) ? (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm">{analysis.summary}</p>
                {analysis.issues.length > 0 && (
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {analysis.issues.map((issue, i) => (
                      <li key={i} className="flex gap-2">
                        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                        <span>{issue}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {analysis.suggestedDescription && (
                  <details className="rounded-md border bg-muted/30 p-3">
                    <summary className="cursor-pointer text-sm text-muted-foreground">
                      {t("jira.suggestedDescription", { defaultValue: "Suggested description (preview)" })}
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap text-sm">{analysis.suggestedDescription}</p>
                  </details>
                )}
                <p className="text-xs text-muted-foreground">
                  {t("jira.confidence", { defaultValue: "Confidence: {{level}}", level: analysis.confidence })}
                </p>
              </div>
            ) : analysisError ? (
              <div className="flex items-start justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                <span>{analysisErrorText}</span>
                {!analysisOff && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 gap-1 px-2 text-xs"
                    disabled={analyzing}
                    onClick={() => void runAnalysis(detailTask, true)}
                  >
                    <RotateCw className={`h-3 w-3 ${analyzing ? "animate-spin" : ""}`} />
                    {t("jira.retryAnalysis", { defaultValue: "Retry" })}
                  </Button>
                )}
              </div>
            ) : analyzing ? (
              <p className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("jira.analyzing", { defaultValue: "Analyzing…" })}
              </p>
            ) : analysisOff ? (
              <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {t("jira.analysisDisabled", { defaultValue: "AI analysis is turned off. Enable an analysis level in Settings → Jira." })}
              </p>
            ) : (
              <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {t("jira.noAnalysis", { defaultValue: "No analysis yet. Open this issue once, or enable periodic polling in Settings." })}
              </p>
            )}
          </section>
        </div>
      </ScrollArea>

      {/* Footer action */}
      <div className="flex items-center gap-3 border-t px-4 py-3">
        <Button
          onClick={handleIngest}
          disabled={ingesting || imported || !project}
          variant={imported ? "outline" : "default"}
        >
          {ingesting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <BookUp className="mr-2 h-4 w-4" />
          )}
          {imported
            ? t("jira.imported", { defaultValue: "In wiki" })
            : t("jira.ingestToWiki", { defaultValue: "Ingest to wiki" })}
        </Button>
        {message && (
          <span className={`text-xs ${message.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  )
}
