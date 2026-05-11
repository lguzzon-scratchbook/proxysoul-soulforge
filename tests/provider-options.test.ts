import { describe, expect, test } from "bun:test";
import {
  buildProviderOptions,
  degradeProviderOptions,
  detectModelFamily,
} from "../src/core/llm/provider-options.js";
import type { AppConfig } from "../src/types/index.js";
import { getCompatReasoningBody } from "../src/core/llm/compat-reasoning.js";

function baseConfig(perf: Partial<AppConfig["performance"]> = {}): AppConfig {
  return {
    defaultModel: "",
    routerRules: [],
    editor: { command: "nvim", args: [] },
    theme: { name: "default" },
    performance: perf,
  } as unknown as AppConfig;
}

describe("Bedrock", () => {
      test("emits providerOptions.bedrock.reasoningConfig (not anthropic)", async () => {
        const cfg = baseConfig({ effort: "high" });
        (cfg as { thinking?: unknown }).thinking = { mode: "enabled", budgetTokens: 8192 };
        const { providerOptions } = await buildProviderOptions(
          "bedrock/anthropic.claude-sonnet-4-6-v1",
          cfg,
        );
        expect(providerOptions.bedrock).toMatchObject({
          reasoningConfig: { type: "enabled", budgetTokens: 8192 },
        });
        expect(providerOptions.anthropic).toBeUndefined();
      });

      test("adaptive thinking → reasoningConfig.type=adaptive", async () => {
        const cfg = baseConfig() as AppConfig;
        (cfg as { thinking?: unknown }).thinking = { mode: "adaptive" };
        const { providerOptions } = await buildProviderOptions(
          "bedrock/anthropic.claude-opus-4-7",
          cfg,
        );
        expect((providerOptions.bedrock as Record<string, unknown>).reasoningConfig).toMatchObject({
          type: "adaptive",
        });
      });
    });

    describe("Claude on opencode-zen — body injection", () => {
      test("emits Anthropic-shape thinking body via compat-reasoning", () => {
        const cfg = baseConfig({ effort: "high" }) as AppConfig;
        (cfg as { thinking?: unknown }).thinking = { mode: "enabled", budgetTokens: 12000 };
        const body = getCompatReasoningBody("opencode-zen/claude-sonnet-4.6", cfg);
        expect(body).toEqual({
          thinking: { type: "enabled", budget_tokens: 12000 },
        });
      });

      test("budget falls back to effort heuristic when thinking budget unset", () => {
        const cfg = baseConfig({ effort: "low" });
        const body = getCompatReasoningBody("opencode-zen/claude-opus-4.6", cfg);
        expect(body).toEqual({
          thinking: { type: "enabled", budget_tokens: 2048 },
        });
      });
    });

    describe("OpenRouter — Claude budget inheritance", () => {
      test("inherits config.thinking.budgetTokens as max_tokens", async () => {
        const cfg = baseConfig() as AppConfig;
        (cfg as { thinking?: unknown }).thinking = { mode: "enabled", budgetTokens: 8192 };
        const { providerOptions } = await buildProviderOptions(
          "openrouter/anthropic/claude-sonnet-4.6",
          cfg,
        );
        expect(providerOptions.openrouter).toEqual({ reasoning: { max_tokens: 8192 } });
      });

      test("explicit openrouterReasoningMaxTokens wins over thinking budget", async () => {
        const cfg = baseConfig({ openrouterReasoningMaxTokens: 4096 }) as AppConfig;
        (cfg as { thinking?: unknown }).thinking = { mode: "enabled", budgetTokens: 8192 };
        const { providerOptions } = await buildProviderOptions(
          "openrouter/anthropic/claude-sonnet-4.6",
          cfg,
        );
        expect(providerOptions.openrouter).toEqual({ reasoning: { max_tokens: 4096 } });
      });
    });

    describe("OpenAI additional knobs", () => {
      test("reasoningSummary + verbosity propagate", async () => {
        const cfg = baseConfig({
          openaiReasoningEffort: "high",
          openaiReasoningSummary: "detailed",
          openaiVerbosity: "low",
        });
        const { providerOptions } = await buildProviderOptions("openai/gpt-5", cfg);
        expect(providerOptions.openai).toMatchObject({
          reasoningEffort: "high",
          reasoningSummary: "detailed",
          verbosity: "low",
        });
      });
    });

    describe("degradeProviderOptions — multi-family", () => {
      test("anthropic still degrades to minimal thinking", () => {
        const { providerOptions } = degradeProviderOptions("anthropic/claude-opus-4-6", 1);
        expect(providerOptions.anthropic).toMatchObject({
          thinking: { type: "enabled", budgetTokens: 5000 },
        });
      });

      test("openai degrades to low effort", () => {
        const { providerOptions } = degradeProviderOptions("openai/gpt-5", 1);
        expect(providerOptions.openai).toEqual({ reasoningEffort: "low" });
      });

      test("xai degrades to low effort", () => {
        const { providerOptions } = degradeProviderOptions("xai/grok-4-fast", 1);
        expect(providerOptions.xai).toEqual({ reasoningEffort: "low" });
      });

      test("google degrades to thinkingLevel low (Gemini 3)", () => {
        const { providerOptions } = degradeProviderOptions("google/gemini-3.1-pro-preview", 1);
        expect(providerOptions.google).toEqual({ thinkingConfig: { thinkingLevel: "low" } });
      });

      test("google degrades to small thinkingBudget (Gemini 2.5)", () => {
        const { providerOptions } = degradeProviderOptions("google/gemini-2.5-flash", 1);
        expect(providerOptions.google).toEqual({ thinkingConfig: { thinkingBudget: 1024 } });
      });

  test("level 2 wipes all options", () => {
    const { providerOptions } = degradeProviderOptions("anthropic/claude-opus-4-6", 2);
    expect(providerOptions).toEqual({});
  });
});

describe("xAI clamping (chat API: low|high only)", () => {
  test("medium explicit clamps to high", async () => {
    const cfg = baseConfig({ xaiReasoningEffort: "medium" });
    const { providerOptions } = await buildProviderOptions("xai/grok-4-fast", cfg);
    expect(providerOptions.xai).toEqual({ reasoningEffort: "high" });
  });

  test("unified effort medium maps to high (chat-safe)", async () => {
    const cfg = baseConfig({ effort: "medium" });
    const { providerOptions } = await buildProviderOptions("xai/grok-4-fast", cfg);
    expect(providerOptions.xai).toEqual({ reasoningEffort: "high" });
  });
});

describe("Groq Qwen3 quirk", () => {
  test("qwen3 emits reasoning_effort=default (not low/medium/high)", () => {
    const cfg = baseConfig({ groqReasoningEffort: "high" });
    const body = getCompatReasoningBody("groq/qwen/qwen3-32b", cfg);
    expect(body).toEqual({ reasoning_effort: "default" });
  });

  test("gpt-oss on Groq keeps high", () => {
    const cfg = baseConfig({ groqReasoningEffort: "high" });
    const body = getCompatReasoningBody("groq/openai/gpt-oss-120b", cfg);
    expect(body.reasoning_effort).toBe("high");
  });
});

describe("detectModelFamily", () => {
  test("openrouter anthropic prefix → claude", () => {
    expect(detectModelFamily("openrouter/anthropic/claude-sonnet-4.6")).toBe("claude");
  });

  test("openrouter google prefix → google", () => {
    expect(detectModelFamily("openrouter/google/gemini-2.5-pro")).toBe("google");
  });

  test("openrouter x-ai prefix → xai", () => {
    expect(detectModelFamily("openrouter/x-ai/grok-4")).toBe("xai");
  });

  test("direct xai → xai", () => {
    expect(detectModelFamily("xai/grok-4-fast")).toBe("xai");
  });

  test("direct deepseek → deepseek", () => {
    expect(detectModelFamily("deepseek/deepseek-chat")).toBe("deepseek");
  });
});

describe("buildProviderOptions — xAI", () => {
  test("grok-4 emits providerOptions.xai.reasoningEffort (not openai)", async () => {
    const cfg = baseConfig({ effort: "high" });
    const { providerOptions } = await buildProviderOptions("xai/grok-4-fast", cfg);
    expect(providerOptions.xai).toEqual({ reasoningEffort: "high" });
    expect(providerOptions.openai).toBeUndefined();
  });

  test("explicit xaiReasoningEffort overrides unified effort", async () => {
    const cfg = baseConfig({ effort: "high", xaiReasoningEffort: "low" });
    const { providerOptions } = await buildProviderOptions("xai/grok-4-fast", cfg);
    expect(providerOptions.xai).toEqual({ reasoningEffort: "low" });
  });
});

describe("buildProviderOptions — Google", () => {
  test("gemini-3.1-pro emits thinkingConfig.thinkingLevel", async () => {
    const cfg = baseConfig({ effort: "high" });
    const { providerOptions } = await buildProviderOptions("google/gemini-3.1-pro-preview", cfg);
    expect(providerOptions.google).toMatchObject({
      thinkingConfig: { thinkingLevel: "high" },
    });
  });

  test("gemini-2.5-flash emits thinkingConfig.thinkingBudget", async () => {
    const cfg = baseConfig({ effort: "high" });
    const { providerOptions } = await buildProviderOptions("google/gemini-2.5-flash", cfg);
    expect((providerOptions.google as Record<string, unknown>).thinkingConfig).toMatchObject({
      thinkingBudget: 8192,
    });
  });

  test("explicit googleThinkingLevel wins on gemini-3", async () => {
    const cfg = baseConfig({ googleThinkingLevel: "minimal" });
    const { providerOptions } = await buildProviderOptions("google/gemini-3-flash-preview", cfg);
    expect((providerOptions.google as Record<string, unknown>).thinkingConfig).toEqual({
      thinkingLevel: "minimal",
    });
  });
});

describe("buildProviderOptions — DeepSeek", () => {
  test("deepseek-chat emits providerOptions.deepseek.thinking", async () => {
    const cfg = baseConfig({ effort: "high" });
    const { providerOptions } = await buildProviderOptions("deepseek/deepseek-chat", cfg);
    expect(providerOptions.deepseek).toEqual({ thinking: { type: "enabled" } });
  });

  test("explicit off disables thinking", async () => {
    const cfg = baseConfig({ effort: "high", deepseekThinking: "off" });
    const { providerOptions } = await buildProviderOptions("deepseek/deepseek-chat", cfg);
    expect(providerOptions.deepseek).toBeUndefined();
  });
});

describe("buildProviderOptions — OpenRouter", () => {
  test("openrouter emits unified reasoning.effort", async () => {
    const cfg = baseConfig({ effort: "high" });
    const { providerOptions } = await buildProviderOptions(
      "openrouter/anthropic/claude-sonnet-4.6",
      cfg,
    );
    expect(providerOptions.openrouter).toEqual({ reasoning: { effort: "high" } });
  });

  test("openrouter max_tokens takes priority over effort", async () => {
    const cfg = baseConfig({
      effort: "high",
      openrouterReasoningMaxTokens: 4096,
    });
    const { providerOptions } = await buildProviderOptions(
      "openrouter/anthropic/claude-sonnet-4.6",
      cfg,
    );
    expect(providerOptions.openrouter).toEqual({ reasoning: { max_tokens: 4096 } });
  });

  test("openrouter exclude flag", async () => {
    const cfg = baseConfig({ effort: "low", openrouterExcludeReasoning: true });
    const { providerOptions } = await buildProviderOptions("openrouter/openai/gpt-5", cfg);
    expect(providerOptions.openrouter).toEqual({
      reasoning: { effort: "low", exclude: true },
    });
  });
});

describe("buildProviderOptions — regression: existing behaviour preserved", () => {
  test("anthropic/claude-opus-4-6 still emits adaptive thinking", async () => {
    const cfg = baseConfig() as AppConfig;
    (cfg as { thinking?: unknown }).thinking = { mode: "adaptive" };
    const { providerOptions } = await buildProviderOptions("anthropic/claude-opus-4-6", cfg);
    expect(providerOptions.anthropic).toMatchObject({ thinking: { type: "adaptive" } });
  });

  test("openai/gpt-5 still emits reasoningEffort", async () => {
    const cfg = baseConfig({ openaiReasoningEffort: "high" });
    const { providerOptions } = await buildProviderOptions("openai/gpt-5", cfg);
    expect(providerOptions.openai).toMatchObject({ reasoningEffort: "high" });
  });
});

describe("getCompatReasoningBody", () => {
  test("deepseek/deepseek-chat returns reasoning_effort body", () => {
    const cfg = baseConfig({ effort: "high" });
    const body = getCompatReasoningBody("deepseek/deepseek-chat", cfg);
    expect(body.reasoning_effort).toBe("high");
  });

  test("groq with groqReasoningEffort populates body (gpt-oss → medium)", () => {
    const cfg = baseConfig({ groqReasoningEffort: "medium" });
    const body = getCompatReasoningBody("groq/openai/gpt-oss-120b", cfg);
    expect(body.reasoning_effort).toBe("medium");
  });

  test("opencode-go GLM picks up dashscope enable_thinking", () => {
    const cfg = baseConfig({ compatReasoningEffort: "high" });
    const body = getCompatReasoningBody("opencode-go/glm-5.1", cfg);
    expect(body.reasoning_effort).toBe("high");
    expect(body.enable_thinking).toBe(true);
  });

  test("returns empty when no effort set", () => {
    const cfg = baseConfig();
    expect(getCompatReasoningBody("groq/qwen3-32b", cfg)).toEqual({});
  });
});
