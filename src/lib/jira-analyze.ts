/**
 * AI analysis of a Jira issue description.
 *
 * Produces a structured `JiraAnalysis` by asking the configured LLM to
 * review the issue against (optionally) knowledge-base context. It is
 * deliberately close to the ingest/review helpers: build a prompt, call
 * `streamChat` non-streaming, parse a JSON block back out.
 *
 * Decoupling note: this module reads the LLM config from the wiki store
 * (via `getTaskLlmConfig`) and may pull knowledge-base snippets via
 * `searchWiki`, both through existing seams. It never imports the Jira
 * UI or the ingest pipeline.
 */
import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat } from "@/lib/llm-client"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import type { JiraTask } from "@/stores/jira-store"
import { isFetchNetworkError } from "@/lib/tauri-fetch"

export interface JiraAnalysis {
  /** One-line verdict, e.g. "描述基本合理，但缺验收标准". */
  summary: string
  /** Non-empty list of problems / risks / open questions. */
  issues: string[]
  /** Rewritten description the user can accept or edit, or "" if none. */
  suggestedDescription: string
  confidence: "low" | "medium" | "high"
  generatedAt: number
}

/** Rendered when analysis can't be produced (no LLM, or an error). */
export interface JiraAnalysisUnavailable {
  reason: string
}

export type JiraAnalysisResult = JiraAnalysis | JiraAnalysisUnavailable

function isAnalysisUnavailable(r: JiraAnalysisResult): r is JiraAnalysisUnavailable {
  return "reason" in r
}

export function isJiraAnalysis(result: JiraAnalysisResult | undefined): result is JiraAnalysis {
  return result !== undefined && !isAnalysisUnavailable(result)
}

/** System prompt guiding the reviewer. Keep the output strict JSON. */
const SYSTEM_PROMPT = `You are a senior engineering reviewer. You evaluate whether a Jira task description is complete and technically sound before work starts.

You will be given:
1. A Jira task (key, type, title, description, optional acceptance criteria).
2. Optional context from the project knowledge base.

Assess the description for: missing requirements, ambiguity, contradictions, missing acceptance criteria, scope creep, missing dependencies, unverifiable claims, and unsafe/extreme wording.

Return ONLY a JSON object with exactly these keys:
{
  "summary": "<one sentence verdict>",
  "issues": ["<problem 1>", "<problem 2>"],
  "suggestedDescription": "<a concrete improved description, or the empty string if no rewrite is warranted>",
  "confidence": "low" | "medium" | "high"
}
Do not wrap the JSON in markdown fences. Do not add commentary outside the JSON.`

/** Extract the first balanced JSON object from an LLM reply. */
export function parseAnalysisJson(text: string): JiraAnalysis | null {
  // Trim BOM / whitespace and strip a leading ```json fence if the model
  // wrapped the payload anyway.
  let body = text.trim().replace(/^﻿/, "")
  const fence = body.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/)
  if (fence) body = fence[1].trim()

  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start < 0 || end <= start) return null

  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as Partial<JiraAnalysis>
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter((i): i is string => typeof i === "string")
      : []
    const confidence =
      parsed.confidence === "low" || parsed.confidence === "high" ? parsed.confidence : "medium"
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      issues,
      suggestedDescription:
        typeof parsed.suggestedDescription === "string" ? parsed.suggestedDescription : "",
      confidence,
      generatedAt: Date.now(),
    }
  } catch {
    return null
  }
}

/** A short display of the knowledge-base snippet to inject into the prompt. */
function renderContextSnippets(snippets: Array<{ title: string; snippet: string }>): string {
  if (snippets.length === 0) return "(no knowledge-base context found)"
  return snippets
    .map((s) => `- ${s.title}: ${s.snippet.slice(0, 400)}`)
    .join("\n")
}

/**
 * Build the user message for the analysis request. Pure so unit tests can
 * assert the prompt shape without invoking the LLM.
 */
export function buildAnalysisPrompt(task: JiraTask, contextSnippets: string[]): string {
  return [
    `# Jira task`,
    `- Key: ${task.key}`,
    `- Type: ${task.type}`,
    `- Title: ${task.summary}`,
    `- Status: ${task.status}`,
    task.assignee ? `- Assignee: ${task.assignee}` : "",
    ``,
    `## Description`,
    task.description || "(no description)",
    ``,
    `## Knowledge base context`,
    renderContextSnippets(
      contextSnippets.map((snippet, i) => ({ title: `snippet ${i + 1}`, snippet })),
    ),
    ``,
    `Assess the description above for completeness, clarity, and technical soundness.`,
  ]
    .filter((line) => line !== "")
    .join("\n")
}

/** Wrapper that turns the streaming completion into a resolved string. */
export async function completeLlm(
  config: LlmConfig,
  system: string,
  user: string,
): Promise<string> {
  let content = ""
  let errorMessage: string | null = null
  await streamChat(
    config,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    {
      onToken: (token) => { content += token },
      onDone: () => {},
      onError: (err) => { errorMessage = err.message },
    },
    undefined,
    { max_tokens: 700, reasoning: { mode: "auto" } },
  )
  if (errorMessage) throw new Error(errorMessage)
  return content
}

export interface AnalyzeOptions {
  /** Override the resolved LLM config (mainly for tests). */
  llmConfig?: LlmConfig
  /** Knowledge-base snippets to fold into the prompt (already fetched). */
  contextSnippets?: string[]
  /** Skip the LLM entirely and return an "off" placeholder. */
  analysisLevel?: "off" | "basic" | "deep"
}

/**
 * Analyze a Jira task. Returns a `JiraAnalysis` on success, or an
 * `JiraAnalysisUnavailable` describing why not (no usable LLM, or a
 * transport/parse failure — analysis is best-effort, never fatal).
 */
export async function analyzeJiraTask(
  task: JiraTask,
  options: AnalyzeOptions = {},
): Promise<JiraAnalysisResult> {
  const level = options.analysisLevel ?? "basic"
  if (level === "off") {
    return { reason: "AI analysis is disabled (off)." }
  }

  const config = options.llmConfig ?? getTaskLlmConfig("ingest")
  if (!hasUsableLlm(config)) {
    return { reason: "No usable LLM is configured. Analysis skipped." }
  }

  // For `deep` we prefer a longer prompt; `basic` focuses on the description
  // alone but still allows context. The caller supplies contextSnippets.
  const user = buildAnalysisPrompt(task, options.contextSnippets ?? [])
  try {
    const raw = await completeLlm(config, SYSTEM_PROMPT, user)
    const parsed = parseAnalysisJson(raw)
    if (!parsed) {
      return { reason: "Analysis returned an unexpected response; no JSON found." }
    }
    return parsed
  } catch (err) {
    if (isFetchNetworkError(err)) {
      return { reason: "Network error reaching the LLM during analysis." }
    }
    return { reason: err instanceof Error ? err.message : String(err) }
  }
}

export const __testing = {
  isAnalysisUnavailable,
  systemPrompt: SYSTEM_PROMPT,
}
