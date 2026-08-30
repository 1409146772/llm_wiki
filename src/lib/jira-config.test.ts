import { describe, it, expect } from "vitest"
import {
  normalizeJiraConfig,
  normalizeJiraServer,
  clampJiraPollInterval,
  clampJiraRetention,
  normalizeJiraAnalysisLevel,
  isJiraConfigUsable,
  DEFAULT_JIRA_CONFIG,
  type JiraConfig,
} from "./jira-config"

describe("normalizeJiraServer", () => {
  it("strips trailing slashes", () => {
    expect(normalizeJiraServer("https://jira.cvte.com/")).toBe("https://jira.cvte.com")
    expect(normalizeJiraServer("https://jira.cvte.com///")).toBe("https://jira.cvte.com")
  })
  it("defaults to https when no scheme is given", () => {
    expect(normalizeJiraServer("jira.cvte.com")).toBe("https://jira.cvte.com")
  })
  it("keeps an explicit http scheme", () => {
    expect(normalizeJiraServer("http://10.0.0.5:8080")).toBe("http://10.0.0.5:8080")
  })
  it("trims whitespace", () => {
    expect(normalizeJiraServer("  https://jira.cvte.com  ")).toBe("https://jira.cvte.com")
  })
})

describe("clamps", () => {
  it("clamps poll interval to [1, 1440]", () => {
    expect(clampJiraPollInterval(0)).toBe(1)
    expect(clampJiraPollInterval(30)).toBe(30)
    expect(clampJiraPollInterval(9999)).toBe(1440)
    expect(clampJiraPollInterval(10, 60)).toBe(10)
  })
  it("clamps retention to [1, 8760] hours", () => {
    expect(clampJiraRetention(0)).toBe(1)
    expect(clampJiraRetention(168)).toBe(168)
    expect(clampJiraRetention(999999)).toBe(8760)
  })
  it("uses the fallback on non-finite input", () => {
    expect(clampJiraPollInterval(NaN)).toBe(60)
    expect(clampJiraPollInterval(undefined)).toBe(60)
  })
})

describe("normalizeJiraAnalysisLevel", () => {
  it("accepts the three valid levels", () => {
    expect(normalizeJiraAnalysisLevel("off")).toBe("off")
    expect(normalizeJiraAnalysisLevel("basic")).toBe("basic")
    expect(normalizeJiraAnalysisLevel("deep")).toBe("deep")
  })
  it("defaults unknown values to basic", () => {
    expect(normalizeJiraAnalysisLevel("bogus")).toBe("basic")
    expect(normalizeJiraAnalysisLevel(undefined)).toBe("basic")
  })
})

describe("normalizeJiraConfig", () => {
  it("returns defaults for an empty input", () => {
    const c = normalizeJiraConfig()
    expect(c).toEqual(DEFAULT_JIRA_CONFIG)
  })
  it("applies importEnabled default true", () => {
    const c = normalizeJiraConfig({ importEnabled: false })
    expect(c.importEnabled).toBe(false)
    const c2 = normalizeJiraConfig({})
    expect(c2.importEnabled).toBe(true)
  })
  it("applies enabled (feature master switch) default true", () => {
    expect(normalizeJiraConfig().enabled).toBe(true)
    expect(normalizeJiraConfig({ enabled: false }).enabled).toBe(false)
    expect(normalizeJiraConfig({ enabled: true }).enabled).toBe(true)
    // Backward compat: a config persisted before `enabled` existed must
    // normalize to on, not silently disable the feature.
    const legacy = { ...DEFAULT_JIRA_CONFIG } as Record<string, unknown>
    delete legacy.enabled
    expect(normalizeJiraConfig(legacy as Partial<JiraConfig>).enabled).toBe(true)
  })
  it("preserves token and trims email", () => {
    const c = normalizeJiraConfig({ token: "pat-123", email: "  a@b.com " })
    expect(c.token).toBe("pat-123")
    expect(c.email).toBe("a@b.com")
  })
  it("coerces non-number lastPoll to null", () => {
    const c = normalizeJiraConfig({ lastPoll: 123 })
    expect(c.lastPoll).toBe(123)
    const c2 = normalizeJiraConfig({ lastPoll: "nope" as unknown as number })
    expect(c2.lastPoll).toBe(null)
  })
})

describe("isJiraConfigUsable", () => {
  it("requires both server and token", () => {
    expect(isJiraConfigUsable({ ...DEFAULT_JIRA_CONFIG, server: "https://jira.cvte.com", token: "pat" })).toBe(true)
    expect(isJiraConfigUsable({ ...DEFAULT_JIRA_CONFIG, server: "", token: "pat" })).toBe(false)
    expect(isJiraConfigUsable({ ...DEFAULT_JIRA_CONFIG, server: "https://jira.cvte.com", token: "" })).toBe(false)
  })
})
