import { describe, expect, it } from "vitest";
import { DEV_AUTH_SECRET, EnvSchema, getLlmConfig, requireGraphVersion, loadEnv } from "./env";

describe("environment boundaries", () => {
  it.each([["false", false], ["0", false], ["true", true], ["1", true]])("parses mock mode %s", (value, expected) => {
    expect(EnvSchema.parse({ META_MOCK_MODE: value }).META_MOCK_MODE).toBe(expected);
  });
  it("rejects ambiguous mock flags and partial encryption keys", () => {
    expect(EnvSchema.safeParse({ META_MOCK_MODE: "maybe" }).success).toBe(false);
    expect(EnvSchema.safeParse({ ENCRYPTION_KEY: "abc123" }).success).toBe(false);
  });
  it("accepts unconfigured optional fields from the example env file", () => {
    const env = EnvSchema.parse({
      META_GRAPH_API_VERSION: "",
      WEEKLY_REPORT_RECIPIENT: "",
      META_REDIRECT_URI: "",
      ENCRYPTION_KEY: "",
      LLM_MODEL: "",
    });
    expect(env.META_GRAPH_API_VERSION).toBeUndefined();
    expect(env.WEEKLY_REPORT_RECIPIENT).toBeUndefined();
    expect(env.META_REDIRECT_URI).toBe("http://localhost:3000/api/meta/oauth/callback");
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(env.LLM_MODEL).toBeUndefined();
  });
  it("has no hard-coded LLM model", () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevModel = process.env.LLM_MODEL;
    process.env.ANTHROPIC_API_KEY = "k";
    delete process.env.LLM_MODEL;
    expect(getLlmConfig()).toBeNull();
    process.env.LLM_MODEL = "some-model";
    expect(getLlmConfig()).toEqual({ apiKey: "k", model: "some-model" });
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevModel === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = prevModel;
  });
  it("resolves the Graph version from env, preferring META_GRAPH_API_VERSION", () => {
    const env = loadEnv({ fresh: true, overrides: { META_API_VERSION: "v25.0", META_GRAPH_API_VERSION: "v26.0" } });
    expect(env.metaGraphApiVersion).toBe("v26.0");
    expect(requireGraphVersion()).toBe("v26.0");
    expect(requireGraphVersion("v27.0")).toBe("v27.0");
    expect(() => requireGraphVersion("26")).toThrow();
    loadEnv({ fresh: true });
  });
});

describe("production guard", () => {
  it("rejects dev defaults and unset mock mode in production, allows explicit demo", () => {
    const strict = () => loadEnv({ fresh: true, overrides: { NODE_ENV: "production", AUTH_SECRET: "x".repeat(40), ENCRYPTION_KEY: "a".repeat(64), META_API_VERSION: "v26.0" } });
    expect(strict).toThrow(/META_MOCK_MODE/);
    expect(() => loadEnv({ fresh: true, overrides: { NODE_ENV: "production", AUTH_SECRET: "x".repeat(40), ENCRYPTION_KEY: "a".repeat(64), META_API_VERSION: "v26.0", META_MOCK_MODE: "false" } })).not.toThrow();
    expect(() => loadEnv({ fresh: true, overrides: { NODE_ENV: "production", AUTH_SECRET: "x".repeat(40), ENCRYPTION_KEY: "a".repeat(64), ALLOW_MOCK_IN_PRODUCTION: "true" } })).not.toThrow();
    expect(() => loadEnv({ fresh: true, overrides: { NODE_ENV: "production", META_MOCK_MODE: "false", META_API_VERSION: "v26.0", AUTH_SECRET: DEV_AUTH_SECRET, ENCRYPTION_KEY: "" } })).toThrow(/AUTH_SECRET|ENCRYPTION_KEY/);
    loadEnv({ fresh: true });
  });
  it("coerces mock mode spellings and accepts shorter legacy hex keys", () => {
    expect(EnvSchema.parse({ META_MOCK_MODE: "TRUE" }).META_MOCK_MODE).toBe(true);
    expect(EnvSchema.parse({ META_MOCK_MODE: "No" }).META_MOCK_MODE).toBe(false);
    expect(EnvSchema.parse({ META_MOCK_MODE: "" }).META_MOCK_MODE).toBe(true);
    expect(EnvSchema.safeParse({ ENCRYPTION_KEY: "ab".repeat(16) }).success).toBe(true);
    expect(EnvSchema.safeParse({ ENCRYPTION_KEY: "abc123" }).success).toBe(false);
  });
});
