import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { RefreshCw, Wifi, WifiOff, AlertTriangle } from "lucide-react"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import { jiraTestConnection } from "@/lib/jira-api"
import { normalizeJiraServer, type JiraConfig } from "@/lib/jira-config"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export function JiraSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

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

      {/* Feature master switch — gates the whole form below plus the
          sidebar entry, the Jira view, and the background poller.
          (When off: form greyed, sidebar entry hidden, poller stopped,
          and the Jira view falls back to the wiki panel.) */}
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

      {/* Disabled-but-visible when the master switch is off: the native
          fieldset cascade greys every control below. */}
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

      {/* Default import + JQL */}
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

      <div className="space-y-2">
        <Label htmlFor="jira-jql">
          {t("settings.sections.jira.jql", { defaultValue: "Issues to import (JQL)" })}
        </Label>
        <textarea
          id="jira-jql"
          value={draft.jiraJql}
          onChange={(e) => setDraft("jiraJql", e.target.value)}
          rows={2}
          disabled={!draft.jiraImportEnabled}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          placeholder="issuetype in (缺陷,Bug) order by updated DESC"
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.jira.jqlHelp", {
            defaultValue:
              "Jira Query Language filters which issues are pulled into the knowledge base. Defects are the default; widen it with `or` or project keys.",
          })}
        </p>
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
