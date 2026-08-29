import { describe, it, expect, vi } from "vitest"
import { parseAnalysisJson, buildAnalysisPrompt, analyzeJiraTask } from "./jira-analyze"
import type { JiraTask } from "@/stores/jira-store"

// Mock the LLM transport so analyzeJiraTask drives streamChat without
// network. We make onToken emit a canned JSON payload.
const emitLLM = vi.fn()
vi.mock("./llm-client", async () => {
  return {
    streamChat: async (config: unknown, messages: unknown[], callbacks: { onToken: (s: string) => void }) => {
      emitLLM(config, messages)
      callbacks.onToken('{"summary":"mock","issues":["a"],"suggestedDescription":"b","confidence":"high"}')
    },
    isFetchNetworkError: () => false,
  }
})

// hasUsableLlm import comes through jira-analyze; keep it real.
// It depends on provider/apiKey.

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

describe("parseAnalysisJson", () => {
  it("parses a plain JSON object", () => {
    const out = parseAnalysisJson(
      '{"summary":"ok","issues":["a","b"],"suggestedDescription":"new","confidence":"high"}',
    )
    expect(out?.summary).toBe("ok")
    expect(out?.issues).toEqual(["a", "b"])
    expect(out?.confidence).toBe("high")
  })

  it("handles a fenced json block", () => {
    const out = parseAnalysisJson('```json\n{"summary":"ok","issues":[],"confidence":"low"}\n```')
    expect(out?.summary).toBe("ok")
    expect(out?.confidence).toBe("low")
  })

  it("rejects non-JSON", () => {
    expect(parseAnalysisJson("not json")).toBe(null)
  })

  it("defaults missing confidence to medium and coerces issues", () => {
    const out = parseAnalysisJson('{"summary":"ok","issues":["a", 1]}')
    expect(out?.confidence).toBe("medium")
    expect(out?.issues).toEqual(["a"])
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
  it("returns unavailable when analysis is off", async () => {
    const result = await analyzeJiraTask(task(), { analysisLevel: "off" })
    expect("reason" in result).toBe(true)
  })

  it("returns unavailable when host LLM has no key", async () => {
    const noLlm = { provider: "openai" as const, apiKey: "" }
    const result = await analyzeJiraTask(task(), { llmConfig: noLlm as never })
    expect("reason" in result).toBe(true)
  })

  it("produces a structured analysis from the mocked LLM", async () => {
    const usableLlm = { provider: "custom" as const, apiKey: "k" }
    const result = await analyzeJiraTask(task(), { llmConfig: usableLlm as never })
    expect("issues" in result).toBe(true)
    if ("issues" in result) {
      expect(result.issues).toEqual(["a"])
      expect(result.summary).toBe("mock")
    }
    expect(emitLLM).toHaveBeenCalled()
  })
})
