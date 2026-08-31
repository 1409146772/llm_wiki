/**
 * Jira integration configuration.
 *
 * This is the persisted shape the settings UI edits and the poller /
 * analyzer consume. It lives in `app-state.json` as a single top-level
 * `jiraConfig` key (global, not per-project) because credentials and
 * defaults are machine-wide — the same rationale as `apiConfig`.
 *
 * Deliberately decoupled: nothing here imports wiki business logic. The
 * module is a pure type + normalize + constants file so it can be reused
 * by the REST layer, the poller, and unit tests without pulling in the
 * ingest pipeline.
 */

export type JiraAnalysisLevel = "off" | "basic" | "deep"

export interface JiraConfig {
  /**
   * Feature master switch: when false the Jira sidebar entry is hidden,
   * the poller never runs, and the Jira view/API surfaces are disabled.
   * Defaults to true so configs saved before this field existed stay on.
   */
  enabled: boolean
  /** Jira base URL, e.g. `https://jira.cvte.com` (no trailing `/`). */
  server: string
  /** Jira account email (used only as a display/label hint). */
  email: string
  /** Personal Access Token. Sensitive: `saveJiraConfig` force-flushes. */
  token: string
  /** Editable JQL that filters which issues are imported. Default: defects. */
  jql: string
  /** Import-level switch: when false, nothing is pulled into the knowledge base. */
  importEnabled: boolean
  /** Whether the periodic background poll runs at all. */
  pollEnabled: boolean
  /** Poll cadence in minutes. Clamped to [1, 1440]. */
  pollIntervalMinutes: number
  /**
   * Dearness of the AI analysis: `off` caches the raw description without
   * calling the LLM, `basic` gives a short sanity check, `deep` runs a
   * context-aware review combining knowledge-base content.
   */
  analysisLevel: JiraAnalysisLevel
  /**
   * Retention buffer (hours) for issues that are resolved in Jira but the
   * user never imported into the wiki. Past this window the issue record +
   * its cached analysis are purged from the ledger. Default 168 = 7 days.
   */
  retentionHours: number
  /** Timestamp of the last successful poll (ms), or null. */
  lastPoll: number | null
}

export const DEFAULT_JIRA_CONFIG: JiraConfig = {
  enabled: true,
  server: "https://jira.cvte.com",
  email: "",
  token: "",
  // Default to the user's own issues; the builder / JQL can widen it.
  jql: "assignee = currentUser() order by updated DESC",
  importEnabled: true,
  pollEnabled: false,
  pollIntervalMinutes: 60,
  analysisLevel: "basic",
  retentionHours: 168,
  lastPoll: null,
}

export function clampJiraPollInterval(value: unknown, fallback = DEFAULT_JIRA_CONFIG.pollIntervalMinutes): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(1, Math.min(1440, n))
}

export function clampJiraRetention(value: unknown, fallback = DEFAULT_JIRA_CONFIG.retentionHours): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback
  // Keep a sane floor so a misconfigured 0 doesn't wipe records instantly.
  return Math.max(1, Math.min(24 * 365, n))
}

export function normalizeJiraAnalysisLevel(value: unknown): JiraAnalysisLevel {
  return value === "off" || value === "deep" ? value : "basic"
}

/** Strip a trailing slash/host path whitespace from a Jira base URL. */
export function normalizeJiraServer(value: string): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "")
  // Accept http or https; if the user typed a bare host, default to https.
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  return scheme
}

export function normalizeJiraConfig(config?: Partial<JiraConfig> | null): JiraConfig {
  return {
    // Defaults to true: a config persisted before `enabled` existed must not
    // silently turn the feature off on upgrade.
    enabled: config?.enabled !== false,
    server: normalizeJiraServer(config?.server ?? DEFAULT_JIRA_CONFIG.server),
    email: (config?.email ?? DEFAULT_JIRA_CONFIG.email).trim(),
    token: config?.token ?? DEFAULT_JIRA_CONFIG.token,
    jql: (config?.jql ?? DEFAULT_JIRA_CONFIG.jql).trim() || DEFAULT_JIRA_CONFIG.jql,
    importEnabled: config?.importEnabled !== false,
    pollEnabled: config?.pollEnabled === true,
    pollIntervalMinutes: clampJiraPollInterval(config?.pollIntervalMinutes),
    analysisLevel: normalizeJiraAnalysisLevel(config?.analysisLevel),
    retentionHours: clampJiraRetention(config?.retentionHours),
    lastPoll:
      typeof config?.lastPoll === "number" && Number.isFinite(config.lastPoll)
        ? config.lastPoll
        : null,
  }
}

/** True when the config has enough to make a Jira REST call. */
export function isJiraConfigUsable(config: JiraConfig): boolean {
  return Boolean(config.server.trim() && config.token.trim())
}
