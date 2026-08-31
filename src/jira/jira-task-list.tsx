import { useTranslation } from "react-i18next"
import { useJiraStore, type JiraTask } from "@/stores/jira-store"

interface Props {
  tasks: JiraTask[]
  onOpen: (task: JiraTask) => void
}

/** Small status pill with color by resolve state (kept simple, not a Badge). */
function statusColor(resolved: boolean): string {
  return resolved
    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
    : "bg-blue-500/15 text-blue-600 dark:text-blue-400"
}

export function JiraTaskList({ tasks, onOpen }: Props) {
  const { t } = useTranslation()
  const ledger = useJiraStore((s) => s.ledger)

  if (tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <p className="text-sm text-muted-foreground">
          {t("jira.empty", { defaultValue: "No issues matched your JQL. Pull to refresh, or open Settings to change the query." })}
        </p>
      </div>
    )
  }

  return (
    <ul className="divide-y divide-border">
      {tasks.map((task) => {
        const entry = ledger.find((item) => item.key === task.key)
        // Only a real analysis counts as "AI analyzed". A cached analysis
        // error (e.g. empty model response) must not masquerade as success —
        // it gets its own "failed" badge so the user knows to retry.
        const hasAnalysis = Boolean(entry?.analysis)
        const analysisFailed = !hasAnalysis && Boolean(entry?.analysisError)
        const imported = Boolean(entry?.imported)
        return (
          <li key={task.key}>
            <button
              type="button"
              onClick={() => onOpen(task)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
            >
              <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">
                {task.key}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{task.summary}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className={`inline-block h-2 w-2 rounded-full ${statusColor(task.resolved)}`} />
                  {task.type && <span>{task.type}</span>}
                  {task.priority && <span>{task.priority}</span>}
                  {task.assignee && <span>{task.assignee}</span>}
                  {hasAnalysis && (
                    <span className="text-blue-500">
                      {t("jira.hasAnalysis", { defaultValue: "AI analyzed" })}
                    </span>
                  )}
                  {analysisFailed && (
                    <span className="text-amber-500">
                      {t("jira.analysisFailed", { defaultValue: "Analysis failed" })}
                    </span>
                  )}
                  {imported && (
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {t("jira.imported", { defaultValue: "In wiki" })}
                    </span>
                  )}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
