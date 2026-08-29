/**
 * Bridge that imports a single Jira issue into the wiki ingest pipeline.
 *
 * This is the ONLY place Jira talks to the ingest pipeline: it writes the
 * task text to `raw/sources/jira/<KEY>.md` (mirroring how url-source-import
 * materializes web pages) and then `enqueueSourceIngest`s it. Everything
 * downstream (source summary page, wiki generation, embeddings, review) is
 * the standard pipeline — no Jira-specific ingest logic duplicated here.
 */
import { writeFile } from "@/commands/fs"
import type { WikiProject } from "@/types/wiki"
import type { LlmConfig } from "@/stores/wiki-store"
import { enqueueSourceIngest, getUniqueDestPath } from "@/lib/source-lifecycle"
import { normalizePath } from "@/lib/path-utils"
import { useJiraStore, type JiraTask } from "@/stores/jira-store"

/** Build the markdown source document for an issue. Pure for unit tests. */
export function jiraTaskMarkdown(task: JiraTask, suggestedDescription?: string): string {
  const lines = [
    `# Jira ${task.key}: ${task.summary}`,
    ``,
    `- **Key**: ${task.key}`,
    task.type ? `- **Type**: ${task.type}` : "",
    task.status ? `- **Status**: ${task.status}` : "",
    task.priority ? `- **Priority**: ${task.priority}` : "",
    task.assignee ? `- **Assignee**: ${task.assignee}` : "",
    ``,
    `## Original description`,
    task.description || "_(no description)_",
  ]

  if (suggestedDescription) {
    lines.push(
      ``,
      `## AI suggested description`,
      suggestedDescription,
    )
  }

  return `${lines.filter((line) => line !== "").join("\n")}\n`
}

/** Leave a trace in the ledger once the issue has been imported. */
export function markJiraImported(key: string): void {
  useJiraStore.getState().markImported(key)
}

async function destFilePath(project: WikiProject, key: string): Promise<string> {
  const dir = `${normalizePath(project.path)}/raw/sources/jira`
  return getUniqueDestPath(dir, `${key}.md`)
}

/**
 * Write the issue to `raw/sources/jira/<KEY>.md` and enqueue it for ingest.
 * Requires a usable LLM (enqueueSourceIngest is a no-op otherwise). Returns
 * the relative source path written, or throws if no usable LLM is set.
 */
export async function jiraTaskToWiki(
  project: WikiProject,
  task: JiraTask,
  llmConfig: LlmConfig,
  suggestedDescription?: string,
): Promise<string> {
  const dest = await destFilePath(project, task.key)
  await writeFile(dest, jiraTaskMarkdown(task, suggestedDescription))
  const ids = await enqueueSourceIngest(project, [dest], llmConfig)
  if (ids.length === 0) {
    throw new Error("No usable LLM is configured; ingested file was saved but not queued.")
  }
  return dest
}
