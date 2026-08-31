/**
 * Jira REST v2 client.
 *
 * This is the only layer that talks to a Jira server. It depends on
 * `getHttpFetch` (Tauri-safe fetch) and a `JiraConfig`; it imports no
 * project/wiki/ingest logic. Mapping Jira JSON → `JiraTask` lives here so
 * UI and poller share one parser.
 *
 * Authentication: `Authorization: Bearer <token>` (Jira Server PAT / API
 * token). 401/403 are surfaced as a dedicated error so the UI can hint the
 * credential is wrong.
 */
import { getHttpFetch } from "@/lib/tauri-fetch"
import { normalizeJiraServer, type JiraConfig } from "@/lib/jira-config"
import type { JiraTask } from "@/stores/jira-store"
import { isResolvedStatus } from "@/stores/jira-store"

const API_VERSION = "2"

export class JiraApiError extends Error {
  status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = "JiraApiError"
    this.status = status
  }
}

/** True when a hostname is a private/LAN/CVTE-internal endpoint Jira can live on. */
function isJiraLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true
  if (host === "::" || host === "::1" || /^(?:fc|fd|fe[89ab])/i.test(host)) return true
  // Anything not a public A/AAAA dotted octet — this lets intranet names like
  // `jira.cvte.com` resolve without a strict private-range check, since the
  // user explicitly configured the URL.
  const parts = host.split(".").map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true
  }
  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function jiraBase(config: JiraConfig): string {
  return normalizeJiraServer(config.server).replace(/\/+$/, "")
}

function jiraUrl(config: JiraConfig, restPath: string): string {
  const path = restPath.startsWith("/") ? restPath.slice(1) : restPath
  return `${jiraBase(config)}/rest/api/${API_VERSION}/${path}`
}

/** Parse a remote ISO datetime (or "now") into milliseconds. */
function parseJiraTime(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

/** Normalize a raw issue JSON payload into our `JiraTask` projection. */
export function mapJiraIssue(raw: unknown): JiraTask | null {
  if (!raw || typeof raw !== "object") return null
  const issue = raw as {
    key?: string
    fields?: Record<string, unknown>
  }
  const key = issue.key
  if (!key) return null
  const fields = issue.fields ?? {}

  const statusObj = (fields.status ?? {}) as { name?: unknown }
  const status = statusObj.name?.toString() ?? ""
  const typeObj = (fields.issuetype ?? {}) as { name?: unknown }
  const priorityObj = (fields.priority ?? {}) as { name?: unknown }
  const assigneeObj = (fields.assignee ?? {}) as { displayName?: unknown; name?: unknown }
  const description = typeof fields.description === "string"
    ? fields.description
    : Array.isArray(fields.description)
      ? (fields.description as Array<{ type?: string; content?: unknown }>)
          .map(renderAdfBlock)
          .filter(Boolean)
          .join("\n")
      : null

  return {
    key,
    summary: fields.summary?.toString() ?? "",
    status,
    type: typeObj.name?.toString() ?? "",
    priority: priorityObj.name?.toString() ?? "",
    assignee:
      (assigneeObj.displayName?.toString() ?? assigneeObj.name?.toString() ?? null) || null,
    description,
    updated: parseJiraTime(fields.updated),
    resolved: isResolvedStatus(status),
  }
}

/** Flatten an Atlassian Document Format node into plain text (best effort). */
function renderAdfBlock(block: { type?: string; content?: unknown }): string {
  if (!block || block.type === "paragraph" || block.type === "heading") {
    const text = renderAdfInline(block.content)
    return text ? `${text}\n` : ""
  }
  const text = renderAdfInline(block.content)
  return text ? `${text}\n` : ""
}

function renderAdfInline(content: unknown): string {
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const node of content as Array<Record<string, unknown>>) {
    if (node.type === "text") {
      parts.push((node.text as string) ?? "")
    } else if (node.type === "hardBreak") {
      parts.push("\n")
    } else if (Array.isArray(node.content)) {
      parts.push(renderAdfInline(node.content))
    } else if (node.type === "listItem" || node.type === "bulletList" || node.type === "orderedList") {
      parts.push(renderAdfInline(node.content))
    }
  }
  return parts.join("")
}

async function jiraFetch<T>(
  config: JiraConfig,
  restPath: string,
  init?: RequestInit,
): Promise<T> {
  if (!config.server.trim()) throw new JiraApiError("Jira server is not configured.", 0)
  if (!config.token.trim()) throw new JiraApiError("Jira token is not configured.", 0)

  // Note: the URL is user-configured, so we don't hard-block non-private
  // hosts — Jira is an intentionally configured integration. We only use
  // the parsed hostname for constructing the request path.
  const httpFetch = await getHttpFetch()
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${config.token}`,
    ...(init?.headers as Record<string, string> | undefined),
  }

  let response: Response
  try {
    response = await httpFetch(jiraUrl(config, restPath), {
      ...init,
      headers,
      signal: init?.signal,
    })
  } catch (err) {
    throw new JiraApiError(
      err instanceof Error ? `Network error reaching Jira: ${err.message}` : "Network error reaching Jira.",
      0,
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new JiraApiError(
      `Jira authentication failed (HTTP ${response.status}). Check the token or use ` +
      `a new PAT with the same account.`,
      response.status,
    )
  }
  if (response.status === 404) {
    throw new JiraApiError("Jira endpoint not found. Check the server URL.", 404)
  }
  if (!response.ok) {
    let detail = ""
    try {
      detail = (await response.text()).slice(0, 500)
    } catch {
      // ignore
    }
    throw new JiraApiError(`Jira request failed (HTTP ${response.status}). ${detail}`, response.status)
  }

  try {
    return (await response.json()) as T
  } catch {
    throw new JiraApiError("Jira returned a non-JSON response.", response.status)
  }
}

export interface JiraSearchOptions {
  jql?: string
  maxResults?: number
  /** Extra comma-separated fields; defaults to a sane minimal set. */
  fields?: string
}

const DEFAULT_FIELDS = "summary,status,issuetype,priority,assignee,description,updated"

/**
 * Search issues by JQL. Returns up to `maxResults` issues mapped to
 * `JiraTask`. A non-existent server or a bad JQL throws `JiraApiError`.
 */
export async function jiraSearch(
  config: JiraConfig,
  options: JiraSearchOptions = {},
): Promise<JiraTask[]> {
  const jql = options.jql || config.jql
  const maxResults = Math.max(1, Math.min(1000, options.maxResults ?? 100))
  const fields = options.fields || DEFAULT_FIELDS
  const query = new URLSearchParams({ jql, maxResults: String(maxResults), fields })
  const payload = await jiraFetch<{ issues?: unknown[] }>(
    config,
    `search?${query.toString()}`,
  )
  const rawIssues = payload.issues ?? []
  const tasks: JiraTask[] = []
  for (const raw of rawIssues) {
    const task = mapJiraIssue(raw)
    if (task) tasks.push(task)
  }
  return tasks
}

/** Fetch a single issue by key. */
export async function jiraGetIssue(config: JiraConfig, key: string): Promise<JiraTask> {
  const raw = await jiraFetch<unknown>(
    config,
    `issue/${encodeURIComponent(key)}?fields=${DEFAULT_FIELDS}`,
  )
  const task = mapJiraIssue(raw)
  if (!task) throw new JiraApiError(`Could not parse issue ${key}.`, 0)
  return task
}

/** Update an issue's description (used for the optional write-back). */
export async function jiraUpdateDescription(
  config: JiraConfig,
  key: string,
  description: string,
): Promise<void> {
  await jiraFetch<unknown>(config, `issue/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ fields: { description } }),
  })
}

export interface JiraNamedEntity {
  id: string
  name: string
  subtask?: boolean
}

/**
 * List issue types for the builder's type dropdown. GET /rest/api/2/issuetype
 * returns a bare array on Jira Server; subtasks are filtered out (they aren't
 * standalone query targets).
 */
export async function jiraIssueTypes(config: JiraConfig): Promise<JiraNamedEntity[]> {
  const data = await jiraFetch<unknown>(config, "issuetype")
  const arr = Array.isArray(data) ? data : []
  return arr
    .map((raw) => {
      const o = raw as { id?: unknown; name?: unknown; subtask?: unknown }
      return { id: String(o.id ?? ""), name: o.name?.toString() ?? "", subtask: Boolean(o.subtask) }
    })
    .filter((t) => t.name && !t.subtask)
}

/**
 * List priorities for the builder's priority dropdown. This Server (9.12.1)
 * returns a bare array; Cloud documents a `{ priorities: [...] }` wrapper —
 * accept both.
 */
export async function jiraPriorities(config: JiraConfig): Promise<JiraNamedEntity[]> {
  const data = await jiraFetch<unknown>(config, "priority")
  const wrapped = (data as { priorities?: unknown } | null)?.priorities
  const arr = Array.isArray(data) ? data : Array.isArray(wrapped) ? wrapped : []
  return arr
    .map((raw) => {
      const o = raw as { id?: unknown; name?: unknown }
      return { id: String(o.id ?? ""), name: o.name?.toString() ?? "" }
    })
    .filter((p) => p.name)
}

/** Validate credentials + server reachability with a lightweight call. */
export async function jiraTestConnection(config: JiraConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const myself = await jiraFetch<{ displayName?: string; name?: string; key?: string }>(
      config,
      "myself",
    )
    const who = myself.displayName ?? myself.name ?? myself.key ?? "user"
    return { ok: true, message: `Connected as ${who}.` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export const __testing = {
  isJiraLocalHost,
  mapJiraIssue,
  jiraBase,
}
