import { describe, expect, test } from "bun:test";
import { CLAUDE_PROMPT } from "../src/core/prompts/families/claude";
import { DEFAULT_PROMPT } from "../src/core/prompts/families/default";
import { GOOGLE_PROMPT } from "../src/core/prompts/families/google";
import { OPENAI_PROMPT } from "../src/core/prompts/families/openai";
import { CORE_RULES, SHARED_IDENTITY, SHARED_RULES } from "../src/core/prompts/families/shared-rules";
import { TOOL_GUIDANCE_WITH_MAP } from "../src/core/prompts/shared/tool-guidance";

// After the 2026 restructure:
// - Tool-selection / workflow / ast_edit examples live ONCE in TOOL_GUIDANCE_WITH_MAP.
// - Family files carry only a tonal delta (<tone> / <agentic_framing> / <core_mandates>).
// - SHARED_RULES is a tight <task_discipline> block (no more generic architecture homilies).

describe("shared-rules content", () => {
  test("is a tight task_discipline block", () => {
    expect(SHARED_RULES).toContain("<task_discipline>");
    expect(SHARED_RULES).toContain("Read code before modifying");
  });

  test("enforces commit etiquette", () => {
    expect(SHARED_RULES).toContain("Only commit when the user explicitly asks");
    expect(SHARED_RULES).toContain("Conventional commits");
  });

  test("dropped generic architecture homilies", () => {
    expect(SHARED_RULES).not.toContain("Code architecture");
    expect(SHARED_RULES).not.toContain("Avoid god files");
    expect(SHARED_RULES).not.toContain("Compose over inherit");
  });

  test("does not duplicate tool-selection (moved to TOOL_GUIDANCE_WITH_MAP)", () => {
    expect(SHARED_RULES).not.toContain("ast_edit is the default");
    expect(SHARED_RULES).not.toContain("soul_find");
  });
});

describe("shared-identity content", () => {
  test("enforces the tool loop contract", () => {
    expect(SHARED_IDENTITY).toContain("<tool_loop>");
    expect(SHARED_IDENTITY).toContain("<answer_voice>");
    // <forbidden_between_tool_calls> bullet list folded inline into <tool_loop>
    expect(SHARED_IDENTITY).toContain("no acknowledgements");
    expect(SHARED_IDENTITY).toContain("no self-narration");
  });

  test("collapsed four overlapping sections into two", () => {
    // Old sections are gone; their content folded into <tool_loop> + <answer_voice>.
    expect(SHARED_IDENTITY).not.toContain("<output_contract>");
    expect(SHARED_IDENTITY).not.toContain("<silent_tool_loop>");
    expect(SHARED_IDENTITY).not.toContain("<when_to_speak>");
    expect(SHARED_IDENTITY).not.toContain("<clarity_exceptions>");
  });

  test("exposes CORE_RULES single-source micro-prompt", () => {
    expect(CORE_RULES).toContain("Silent tool loop");
    expect(CORE_RULES).toContain("Speak only at the end");
  });

  test("warns that interstitial text is invisible to the user", () => {
    expect(CORE_RULES).toContain("Interstitial text is INVISIBLE");
    expect(SHARED_IDENTITY).toContain("Interstitial text is INVISIBLE");
  });
});

describe("family prompts carry only tonal delta", () => {
  test("claude has tone block, no duplicated workflow", () => {
    expect(CLAUDE_PROMPT).toContain("<tone>");
    expect(CLAUDE_PROMPT).not.toContain("<workflow>");
    expect(CLAUDE_PROMPT).not.toContain("soul_find");
  });

  test("openai has agentic framing, no duplicated workflow", () => {
    expect(OPENAI_PROMPT).toContain("<agentic_framing>");
    expect(OPENAI_PROMPT).toContain("Keep going until");
    expect(OPENAI_PROMPT).not.toContain("<workflow>");
    expect(OPENAI_PROMPT).not.toContain("soul_find");
  });

  test("google has core mandates, no duplicated workflow", () => {
    expect(GOOGLE_PROMPT).toContain("<core_mandates>");
    expect(GOOGLE_PROMPT).not.toContain("<workflow>");
    expect(GOOGLE_PROMPT).not.toContain("soul_find");
  });

  test("default has agentic framing scaffold, no duplicated workflow", () => {
    expect(DEFAULT_PROMPT).toContain("<agentic_framing>");
    expect(DEFAULT_PROMPT).not.toContain("<workflow>");
    expect(DEFAULT_PROMPT).not.toContain("soul_find");
  });

  test("no family re-declares silent-tool-use (lives in SHARED_IDENTITY)", () => {
    for (const prompt of [CLAUDE_PROMPT, OPENAI_PROMPT, GOOGLE_PROMPT, DEFAULT_PROMPT]) {
      expect(prompt).not.toContain("# Silent tool use");
    }
  });

  test("no family mentions Task tool (legacy)", () => {
    for (const prompt of [CLAUDE_PROMPT, OPENAI_PROMPT, GOOGLE_PROMPT, DEFAULT_PROMPT]) {
      expect(prompt).not.toContain("Task tool");
    }
  });
});

describe("tool guidance content", () => {
  test("uses XML structure per 2026 context-engineering guidance", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("<tool_usage>");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("<workflow>");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("<soul_map_usage>");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("<tool_selection>");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("<ast_edit>");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("<non_ts_edits>");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("<dispatch>");
  });

  test("is the single source for the workflow recipe", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("PLAN from the map");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("ast_edit for TS/JS");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("project (typecheck/lint/test)");
  });

  test("points at ast_edit tool description for taxonomy + examples", () => {
    // Taxonomy and MICRO/BODY/ATOMIC/CREATE examples relocated to astEditTool.description
    // (cache-stable, lives in tool array). System prompt keeps a short pointer.
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("ast_edit");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("tool's description");
  });

  test("keeps navigate / dep-search / soul_impact guidance", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("navigate");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("node_modules");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("dep");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("package manager");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("soul_impact");
  });

  test("keeps shell and git guidance", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("git");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("soul_vision");
  });

  test("keeps dispatch directives with BAD/GOOD pair", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("BAD:");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("GOOD:");
  });

  test("does not duplicate navigate action list", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).not.toContain("navigate(definition, symbol=");
    expect(TOOL_GUIDANCE_WITH_MAP).not.toContain("navigate(references, symbol=");
  });
});
