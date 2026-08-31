import { useState, useEffect, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { RefreshCw, Wifi, WifiOff, AlertTriangle } from "lucide-react"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import { jiraTestConnection, jiraIssueTypes, jiraPriorities, type JiraNamedEntity } from "@/lib/jira-api"
import { normalizeJiraServer, type JiraConfig } from "@/lib/jira-config"
import { buildJiraJql, parseJiraJql, type JiraScope } from "@/lib/jira-jql"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

// Fallback option lists (used when the server isn't reachable / no creds).
// Mirrors the real issue types + priorities on the target Jira instance.
const STATIC_JIRA_TYPES = ["任务", "缺陷", "项目任务", "测试任务", "需求", "Epic", "设计", "风险"]
const STATIC_JIRA_PRIORITIES = ["最高", "高", "较高", "中", "低", "最低"]

const CONTROL_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"

export function JiraSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [serverTypes, setServerTypes] = useState<JiraNamedEntity[]>([])
  const [serverPrios, setServerPrios] = useState<JiraNamedEntity[]>([])
  const [usingFallback, setUsingFallback] = useState(false)
  const credRef = useRef("")

  const buildConfigForTest = (): JiraConfig => ({
    enabled: draft.jiraEnabled,
    server: normalizeJiraServer(draft.jiraServer),
    email: draft.jiraEmail.trim(),
    token: draft.jiraToken,
    jql: draft.jiraJql.trim(),
    importEnabled: draft.jiraImportEnabled,
    pollEnabled: draft.jiraPollEnabled,
    pollIntervalMinutes: draft.jiraPollIntervalMinutes || 60,
    analysisLevel: draft.jiraAnalysisLevel,
    retentionHours: draft.jiraRetentionHours || 168,
    lastPoll: null,
  })

  const handleTestConnection = async () => {
    // The whole form is disabled when the master switch is off; belt and
    // braces so a stale click can never fire a request.
    if (!draft.jiraEnabled) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await jiraTestConnection(buildConfigForTest())
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const hasCredentials = Boolean(draft.jiraServer.trim() && draft.jiraToken.trim())

  // Pull real issue types / priorities once credentials settle. Failures fall
  // back to the static lists silently — never throw out of the effect.
  useEffect(() => {
    const server = normalizeJiraServer(draft.jiraServer)
    const token = draft.jiraToken.trim()
    if (!server || !token) {
      setServerTypes([])
      setServerPrios([])
      setUsingFallback(false)
      return
    }
    const key = `${server}|${token}`
    if (credRef.current === key) return
    let cancelled = false
    const cfg = buildConfigForTest()
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
  }, [draft.jiraServer, draft.jiraToken])

  const parsed = useMemo(() => parseJiraJql(draft.jiraJql), [draft.jiraJql])
  const typeNames = serverTypes.length ? serverTypes.map((x) => x.name) : STATIC_JIRA_TYPES
  const prioNames = serverPrios.length ? serverPrios.map((x) => x.name) : STATIC_JIRA_PRIORITIES
  const builderDisabled = !draft.jiraImportEnabled || parsed.custom

  const applyFilters = (over: Partial<Pick<ReturnType<typeof parseJiraJql>, "scope" | "types" | "priorities">>) => {
    setDraft("jiraJql", buildJiraJql({ scope: parsed.scope, types: parsed.types, priorities: parsed.priorities, ...over }))
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.jira.title", { defaultValue: "Jira" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.jira.description", {
            defaultValue:
              "Connect a Jira server to browse and import issues into the knowledge base, and analyze descriptions with your configured LLM.",
          })}
        </p>
      </div>

      {/* Feature master switch */}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.jiraEnabled}
          onChange={(e) => setDraft("jiraEnabled", e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm font-medium">
          {t("settings.sections.jira.enabled", { defaultValue: "Enable Jira integration" })}
        </span>
      </label>

      <fieldset disabled={!draft.jiraEnabled} className="min-w-0 space-y-6 disabled:opacity-60">

      {/* Credentials */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="jira-server">
            {t("settings.sections.jira.server", { defaultValue: "Server URL" })}
          </Label>
          <Input
            id="jira-server"
            value={draft.jiraServer}
            onChange={(e) => setDraft("jiraServer", e.target.value)}
            placeholder="https://jira.cvte.com"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="jira-email">
            {t("settings.sections.jira.email", { defaultValue: "Account email" })}
          </Label>
          <Input
            id="jira-email"
            type="email"
            value={draft.jiraEmail}
            onChange={(e) => setDraft("jiraEmail", e.target.value)}
            placeholder="you@example.com"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="jira-token">
          {t("settings.sections.jira.token", { defaultValue: "Personal Access Token" })}
        </Label>
        <Input
          id="jira-token"
          type="password"
          value={draft.jiraToken}
          onChange={(e) => setDraft("jiraToken", e.target.value)}
          placeholder="••••••••••••"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.jira.tokenHelp", {
            defaultValue:
              "Stored locally in app-state.json and sent only to your configured server. Use a Jira API token or PAT built from your email.",
          })}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={handleTestConnection}
          disabled={!hasCredentials || testing}
        >
          {testing ? (
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Wifi className="mr-2 h-4 w-4" />
          )}
          {testing
            ? t("settings.sections.jira.testing", { defaultValue: "Testing..." })
            : t("settings.sections.jira.testConnection", { defaultValue: "Test connection" })}
        </Button>
        {testResult && (
          <span
            className={`flex items-center gap-1 text-xs ${
              testResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
            }`}
          >
            {testResult.ok ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {testResult.message}
          </span>
        )}
      </div>

      {/* Default import + filter builder */}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.jiraImportEnabled}
          onChange={(e) => setDraft("jiraImportEnabled", e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm">
          {t("settings.sections.jira.importEnabled", { defaultValue: "Import Jira issues by default" })}
        </span>
      </label>

      <div className="space-y-3 rounded-md border p-4">
        <div className="flex items-center gap-2">
          <Label>{t("settings.sections.jira.filters", { defaultValue: "Issue filters" })}</Label>
          {parsed.custom && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
              {t("settings.sections.jira.customQuery", { defaultValue: "Custom JQL" })}
            </span>
          )}
        </div>
        {parsed.custom && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.jira.customQueryHelp", {
              defaultValue: "This query uses conditions the visual builder can't represent. Edit it under Advanced below; the builder re-syncs once it's parseable.",
            })}
          </p>
        )}
        {usingFallback && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.jira.optionsFallback", {
              defaultValue: "Showing a built-in option list — connect to your Jira server to load its real issue types and priorities.",
            })}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="jira-filter-scope" className="text-xs text-muted-foreground">
              {t("settings.sections.jira.filterScope", { defaultValue: "Owner" })}
            </Label>
            <select
              id="jira-filter-scope"
              className={CONTROL_CLASS}
              disabled={builderDisabled}
              value={parsed.scope}
              onChange={(e) => applyFilters({ scope: e.target.value as JiraScope })}
            >
              <option value="assignee">{t("settings.sections.jira.scopeAssignee", { defaultValue: "Assigned to me" })}</option>
              <option value="reporter">{t("settings.sections.jira.scopeReporter", { defaultValue: "Reported by me" })}</option>
              <option value="all">{t("settings.sections.jira.scopeAll", { defaultValue: "Everyone" })}</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="jira-filter-types" className="text-xs text-muted-foreground">
              {t("settings.sections.jira.filterTypes", { defaultValue: "Issue types" })}
            </Label>
            <select
              id="jira-filter-types"
              className={CONTROL_CLASS + " h-auto py-1"}
              multiple
              size={5}
              disabled={builderDisabled}
              value={parsed.types}
              onChange={(e) => applyFilters({ types: Array.from(e.target.selectedOptions).map((o) => o.value) })}
            >
              {typeNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="jira-filter-prios" className="text-xs text-muted-foreground">
              {t("settings.sections.jira.filterPriorities", { defaultValue: "Priorities" })}
            </Label>
            <select
              id="jira-filter-prios"
              className={CONTROL_CLASS + " h-auto py-1"}
              multiple
              size={5}
              disabled={builderDisabled}
              value={parsed.priorities}
              onChange={(e) => applyFilters({ priorities: Array.from(e.target.selectedOptions).map((o) => o.value) })}
            >
              {prioNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Advanced: raw JQL, kept in sync with the builder */}
        <details className="rounded-md border bg-muted/20 p-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t("settings.sections.jira.advancedJql", { defaultValue: "Advanced: edit JQL directly" })}
          </summary>
          <div className="mt-3 space-y-2">
            <textarea
              id="jira-jql"
              value={draft.jiraJql}
              onChange={(e) => setDraft("jiraJql", e.target.value)}
              rows={2}
              disabled={!draft.jiraImportEnabled}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              placeholder="assignee = currentUser() order by updated DESC"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.jira.jqlHelp", {
                defaultValue:
                  "Jira Query Language decides which issues are pulled into the knowledge base. The default only shows issues assigned to you.",
              })}
            </p>
            <div className="rounded-md border bg-background p-2 text-xs text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">{t("settings.sections.jira.jqlSyntaxTitle", { defaultValue: "How to write JQL" })}</p>
              <ul className="list-disc space-y-0.5 pl-4">
                <li><code>assignee = currentUser()</code> / <code>reporter = currentUser()</code></li>
                <li><code>issuetype in (任务, 缺陷)</code></li>
                <li><code>priority in (高, 中)</code></li>
                <li><code>project = AERDM AND …</code></li>
              </ul>
              <p className="mt-1">
                {t("settings.sections.jira.jqlSyntax", {
                  defaultValue:
                    "Issue-type and status names must match your server's exact spelling and case. Combine conditions with AND/OR, and preview the query in Jira's web Issue Navigator before saving.",
                })}
              </p>
            </div>
          </div>
        </details>
      </div>

      {/* Poll schedule */}
      {draft.jiraImportEnabled && (
        <div className="space-y-4 rounded-md border p-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.jiraPollEnabled}
              onChange={(e) => setDraft("jiraPollEnabled", e.target.checked)}
              className="h-4 w-4"
            />
            <span className="text-sm">
              {t("settings.sections.jira.pollEnabled", { defaultValue: "Poll periodically" })}
            </span>
          </label>
          {draft.jiraPollEnabled && (
            <div className="space-y-2">
              <Label htmlFor="jira-poll-interval">
                {t("settings.sections.jira.pollInterval", { defaultValue: "Poll interval (minutes)" })}
              </Label>
              <Input
                id="jira-poll-interval"
                type="number"
                min={1}
                max={1440}
                value={draft.jiraPollIntervalMinutes}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val) && val >= 1) setDraft("jiraPollIntervalMinutes", val)
                }}
                className="w-32"
              />
            </div>
          )}
        </div>
      )}

      {/* Analysis level */}
      {draft.jiraImportEnabled && (
        <div className="space-y-2">
          <Label htmlFor="jira-analysis-level">
            {t("settings.sections.jira.analysisLevel", { defaultValue: "AI analysis depth" })}
          </Label>
          <select
            id="jira-analysis-level"
            value={draft.jiraAnalysisLevel}
            onChange={(e) =>
              setDraft("jiraAnalysisLevel", e.target.value as SettingsDraft["jiraAnalysisLevel"])
            }
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="off">
              {t("settings.sections.jira.analysisOff", { defaultValue: "Off — no LLM analysis" })}
            </option>
            <option value="basic">
              {t("settings.sections.jira.analysisBasic", { defaultValue: "Basic — short sanity check" })}
            </option>
            <option value="deep">
              {t("settings.sections.jira.analysisDeep", { defaultValue: "Deep — knowledge-base-aware review" })}
            </option>
          </select>
        </div>
      )}

      {/* Retention */}
      {draft.jiraImportEnabled && (
        <div className="space-y-2">
          <Label htmlFor="jira-retention">
            {t("settings.sections.jira.retention", { defaultValue: "Resolved-unimported retention (hours)" })}
          </Label>
          <Input
            id="jira-retention"
            type="number"
            min={1}
            max={8760}
            value={draft.jiraRetentionHours}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10)
              if (!isNaN(val) && val >= 1) setDraft("jiraRetentionHours", val)
            }}
            className="w-32"
          />
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <AlertTriangle className="h-3 w-3" />
            {t("settings.sections.jira.retentionHelp", {
              defaultValue:
                "How long an issue that is resolved in Jira but never imported stays in history before its info and analysis are discarded. Imported issues are kept forever.",
            })}
          </p>
        </div>
      )}
      </fieldset>
    </div>
  )
}
