import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  parseAnalysisJson,
  buildAnalysisPrompt,
  analyzeJiraTask,
  ANALYSIS_MAX_TOKENS,
  type JiraAnalysisResult,
  type ParseOutcome,
} from "./jira-analyze"
import type { JiraTask } from "@/stores/jira-store"

// Scripted streamChat mock: each LLM attempt shifts one entry off `replies`.
// A string emits as response content; an Error simulates a transport failure;
// a dry queue emits an empty reply (which parse classifies as "empty").
// NOTE: isFetchNetworkError is NOT mocked — jira-analyze imports it from
// tauri-fetch, and the real helper classifies TypeError / "Load failed" shapes.
let replies: Array<string | Error> = []
const calls: Array<{
  config: unknown
  messages: Array<{ role: string; content: string }>
  overrides: unknown
}> = []

vi.mock("./llm-client", () => ({
  streamChat: async (
    config: unknown,
    messages: Array<{ role: string; content: string }>,
    callbacks: { onToken: (s: string) => void },
    _signal: unknown,
    overrides: unknown,
  ) => {
    calls.push({ config, messages, overrides })
    const next = replies.shift()
    if (next instanceof Error) throw next
    callbacks.onToken(next ?? "")
  },
}))

const VALID_JSON = '{"summary":"ok","issues":["a"],"suggestedDescription":"b","confidence":"high"}'

const task = (partial: Partial<JiraTask> = {}): JiraTask => ({
  key: "AERDM-2",
  summary: "Fix crash",
  status: "打开",
  type: "缺陷",
  priority: "中",
  assignee: "luziyu",
  description: "登录后偶发崩溃",
  updated: 123,
  resolved: false,
  ...partial,
})

const usableLlm = { provider: "custom", apiKey: "k" }

function analysisOf(outcome: ParseOutcome) {
  if ("analysis" in outcome) return outcome.analysis
  throw new Error(`expected analysis, got code "${outcome.code}"`)
}

function codeOf(outcome: ParseOutcome) {
  if ("code" in outcome) return outcome.code
  throw new Error("expected a parse-failure code, got an analysis")
}

function expectUnavailable(result: JiraAnalysisResult) {
  if ("reason" in result) return result
  throw new Error("expected an unavailable result")
}

beforeEach(() => {
  replies = []
  calls.length = 0
})

describe("parseAnalysisJson", () => {
  it("parses a plain JSON object", () => {
    const out = analysisOf(
      parseAnalysisJson('{"summary":"ok","issues":["a","b"],"suggestedDescription":"new","confidence":"high"}'),
    )
    expect(out.summary).toBe("ok")
    expect(out.issues).toEqual(["a", "b"])
    expect(out.confidence).toBe("high")
  })

  it("handles a fenced json block", () => {
    const out = analysisOf(parseAnalysisJson('```json\n{"summary":"ok","issues":[],"confidence":"low"}\n```'))
    expect(out.summary).toBe("ok")
    expect(out.confidence).toBe("low")
  })

  it("extracts a JSON object wrapped in prose", () => {
    const raw = `Here is my review:\n${VALID_JSON}\nHope this helps!`
    expect(analysisOf(parseAnalysisJson(raw)).summary).toBe("ok")
  })

  it("takes the first complete object when several appear", () => {
    const raw = `${VALID_JSON}\n{"summary":"second","issues":[],"confidence":"low"}`
    expect(analysisOf(parseAnalysisJson(raw)).summary).toBe("ok")
  })

  it("classifies an unclosed (truncated) JSON reply", () => {
    expect(codeOf(parseAnalysisJson('{"summary":"ok","iss'))).toBe("truncated")
  })

  it("classifies a reply without any JSON", () => {
    expect(codeOf(parseAnalysisJson("not json at all"))).toBe("noJson")
  })

  it("classifies an empty reply", () => {
    expect(codeOf(parseAnalysisJson("   \n  \t"))).toBe("empty")
  })

  it("defaults missing confidence to medium and coerces issues", () => {
    const out = analysisOf(parseAnalysisJson('{"summary":"ok","issues":["a", 1]}'))
    expect(out.confidence).toBe("medium")
    expect(out.issues).toEqual(["a"])
  })
})

describe("buildAnalysisPrompt", () => {
  it("includes the issue and context", () => {
    const prompt = buildAnalysisPrompt(task(), ["kb snippet"])
    expect(prompt).toContain("AERDM-2")
    expect(prompt).toContain("Fix crash")
    expect(prompt).toContain("kb snippet")
  })
})

describe("analyzeJiraTask", () => {
  it("returns unavailable with code 'off' when analysis is disabled", async () => {
    const result = expectUnavailable(await analyzeJiraTask(task(), { analysisLevel: "off" }))
    expect(result.code).toBe("off")
  })

  it("returns unavailable with code 'noLlm' when the host LLM has no key", async () => {
    const noLlm = { provider: "openai", apiKey: "" }
    const result = expectUnavailable(await analyzeJiraTask(task(), { llmConfig: noLlm as never }))
    expect(result.code).toBe("noLlm")
  })

  it("produces a structured analysis from the mocked LLM", async () => {
    replies = [VALID_JSON]
    const result = await analyzeJiraTask(task(), { llmConfig: usableLlm as never })
    expect("issues" in result && result.summary).toBe("ok")
    expect(calls).toHaveLength(1)
  })

  it("sends the raised output budget and ingest-routed reasoning (default off)", async () => {
    replies = [VALID_JSON]
    await analyzeJiraTask(task(), { llmConfig: usableLlm as never })
    const overrides = calls[0].overrides as { max_tokens: number; reasoning: { mode: string } }
    expect(overrides.max_tokens).toBe(ANALYSIS_MAX_TOKENS)
    expect(overrides.max_tokens).toBeGreaterThan(700)
    expect(overrides.reasoning).toEqual({ mode: "off" })
  })

  it("honors a custom ingestReasoning on the routed config", async () => {
    replies = [VALID_JSON]
    await analyzeJiraTask(task(), {
      llmConfig: { ...usableLlm, ingestReasoning: { mode: "auto" } } as never,
    })
    const overrides = calls[0].overrides as { reasoning: { mode: string } }
    expect(overrides.reasoning).toEqual({ mode: "auto" })
  })

  it("retries once with a stricter JSON-only instruction and succeeds", async () => {
    replies = ["Sure! I'll describe the issues in prose instead.", VALID_JSON]
    const result = await analyzeJiraTask(task(), { llmConfig: usableLlm as never })
    expect("issues" in result && result.summary).toBe("ok")
    expect(calls).toHaveLength(2)
    const retryUserMsg = calls[1].messages[calls[1].messages.length - 1].content
    expect(retryUserMsg).toContain("could not be parsed as JSON")
    // The system prompt stays untouched between attempts.
    expect(calls[1].messages[0].content).toBe(calls[0].messages[0].content)
  })

  it("returns the retry's failure classification when both attempts are bad", async () => {
    replies = ["", "still no json here"]
    const result = expectUnavailable(await analyzeJiraTask(task(), { llmConfig: usableLlm as never }))
    // First attempt was "empty", second was prose → the reported code is the
    // second attempt's classification.
    expect(result.code).toBe("noJson")
    expect(result.reason.length).toBeGreaterThan(0)
    expect(calls).toHaveLength(2)
  })

  it("classifies a transport TypeError as 'network' without retrying", async () => {
    replies = [new TypeError("Failed to fetch")]
    const result = expectUnavailable(await analyzeJiraTask(task(), { llmConfig: usableLlm as never }))
    expect(result.code).toBe("network")
    expect(calls).toHaveLength(1)
  })

  it("passes other transport errors through as 'error' with the raw message", async () => {
    replies = [new Error("HTTP 400: max_tokens exceeds the context window")]
    const result = expectUnavailable(await analyzeJiraTask(task(), { llmConfig: usableLlm as never }))
    expect(result.code).toBe("error")
    expect(result.reason).toContain("400")
  })
})
