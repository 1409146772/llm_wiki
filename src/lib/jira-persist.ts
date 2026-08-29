import { writeFile, readFile, createDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { JiraLedgerEntry } from "@/stores/jira-store"

/**
 * Persistence for the Jira ledger, scoped to a project (like review.json /
 * lint.json) under `{project}/.llm-wiki/jira.json`. The ledger holds per-
 * issue analysis cache + import/resolution bookkeeping; it is the only Jira
 * state that needs to survive a restart.
 */

async function ensureJiraDir(projectPath: string): Promise<void> {
  await createDirectory(`${normalizePath(projectPath)}/.llm-wiki`).catch(() => {})
}

export async function saveJiraLedger(
  projectPath: string,
  entries: JiraLedgerEntry[],
): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureJiraDir(pp)
  await writeFile(`${pp}/.llm-wiki/jira.json`, JSON.stringify(entries, null, 2))
}

export async function loadJiraLedger(projectPath: string): Promise<JiraLedgerEntry[]> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${pp}/.llm-wiki/jira.json`)
    const parsed = JSON.parse(content) as JiraLedgerEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    return []
  }
}
