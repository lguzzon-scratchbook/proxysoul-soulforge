import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { jsonrepair } from "jsonrepair";

/**
 * Sanitize tool-call inputs in messages to prevent Anthropic API rejections.
 *
 * When the model generates malformed tool call args (unparseable JSON or non-object
 * JSON like a string/array/number), the AI SDK stores the raw value as `input` and
 * marks the call `invalid: true`. On the next step, the SDK replays these tool_use
 * blocks as-is. The Anthropic API requires `tool_use.input` to be a dictionary —
 * sending a raw string or array causes:
 *   "messages.N.content.M.tool_use.input: Input should be a valid dictionary"
 *
 * This prepareStep hook ensures all tool-call inputs are plain objects.
 */
export function sanitizeMessages(messages: ModelMessage[]): ModelMessage[] {
  let dirty = false;
  const cleaned = messages.map((msg) => {
    if (msg.role !== "assistant" || typeof msg.content === "string") return msg;
    if (!Array.isArray(msg.content)) return msg;

    let contentDirty = false;
    const content = msg.content.map((part) => {
      if (part.type !== "tool-call") return part;
      const input = part.input;
      if (typeof input === "object" && input !== null && !Array.isArray(input)) return part;
      contentDirty = true;
      return { ...part, input: {} };
    });

    if (!contentDirty) return msg;
    dirty = true;
    return { ...msg, content };
  });

  return dirty ? cleaned : messages;
}

/** prepareStep hook that sanitizes tool-call inputs and surfaces abnormal finishes
 *  from the previous step. ToolLoopAgent's `onStepFinish` callback swallows thrown
 *  errors (ai/dist/index.mjs:519 — `notify()` has a bare catch), so prepareStep is
 *  the only safe place to convert a length-truncation into a real stream rejection.
 */
export function sanitizeToolInputsStep({
  messages,
  steps,
}: {
  messages: ModelMessage[];
  steps?: ReadonlyArray<{ finishReason?: string }>;
}): { messages: ModelMessage[] } | undefined {
  const prevStep = steps && steps.length > 0 ? steps[steps.length - 1] : undefined;
  if (prevStep && isAbnormalFinish(prevStep.finishReason)) {
    throw new AbnormalFinishError(prevStep.finishReason);
  }
  const cleaned = sanitizeMessages(messages);
  return cleaned !== messages ? { messages: cleaned } : undefined;
}

export async function repairToolCall({
  toolCall,
  tools,
  error,
}: {
  toolCall: LanguageModelV3ToolCall;
  tools?: Record<string, unknown>;
  error?: { name?: string } | unknown;
}): Promise<LanguageModelV3ToolCall | null> {
  const trimmed = toolCall.input.trim();
  if (!trimmed) return null;

  // Truncation detection: tool name is registered AND we got InvalidToolInputError
  // → the model emitted a real tool call whose JSON args got cut off mid-stream.
  // Signal this to the model instead of routing to a generic "invalid tool" path.
  const errName =
    typeof error === "object" && error !== null && "name" in error
      ? (error as { name?: string }).name
      : undefined;
  const isTruncationCandidate =
    errName === "AI_InvalidToolInputError" && tools != null && toolCall.toolName in tools;

  let repaired: string;
  try {
    repaired = jsonrepair(trimmed);
  } catch {
    if (isTruncationCandidate) {
      return {
        ...toolCall,
        input: JSON.stringify({
          __soulforge_truncated__: true,
          message: `Tool call '${toolCall.toolName}' was truncated at ${MAX_OUTPUT_TOKENS} output tokens — arguments did not finish streaming. Retry with smaller inputs (split write/edit into chunks, narrower ranges) or raise SOULFORGE_MAX_OUTPUT_TOKENS.`,
        }),
      };
    }
    return null;
  }

  // Verify the result is a valid JSON object (not array, string, number, etc.)
  try {
    const parsed = JSON.parse(repaired);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }

  // Nothing changed — no repair was needed
  if (repaired === trimmed) return null;

  return { ...toolCall, input: repaired };
}
/**
 * Max output tokens per step for all ToolLoopAgents.
 *
 * Without this cap, providers/gateways apply their own (often tiny) defaults —
 * e.g. some return finish_reason="length" at 1024 tokens. The SDK's ToolLoopAgent
 * treats any non-"tool-calls" finish reason as end-of-turn, so a length-truncated
 * step terminates the agent silently mid-thought.
 *
 * Override via SOULFORGE_MAX_OUTPUT_TOKENS. Mirrors opencode's pattern.
 */
export const MAX_OUTPUT_TOKENS = Number(process.env.SOULFORGE_MAX_OUTPUT_TOKENS) || 64_000;

/**
 * Finish reasons that mean "the model did not voluntarily stop and did not
 * request a tool" — the agent loop will exit after these but the turn is
 * incomplete. Surface them as errors instead of treating partial output
 * as the final answer.
 */
export type AbnormalFinishReason = "length" | "content-filter" | "error";

export function isAbnormalFinish(
  reason: string | undefined | null,
): reason is AbnormalFinishReason {
  return reason === "length" || reason === "content-filter" || reason === "error";
}

export function describeAbnormalFinish(reason: AbnormalFinishReason): string {
  if (reason === "length")
    return `Model output truncated at ${MAX_OUTPUT_TOKENS} tokens (finish_reason=length). Set SOULFORGE_MAX_OUTPUT_TOKENS to raise the cap.`;
  if (reason === "content-filter")
    return "Model response blocked by content filter (finish_reason=content-filter).";
  return "Model returned finish_reason=error.";
}

/**
 * Thrown from `onStepFinish` when a step finishes with an abnormal reason
 * (length / content-filter / error). Surfaces as a stream rejection so the
 * UI can render it and useChat can decide whether to auto-continue.
 */
export class AbnormalFinishError extends Error {
  readonly reason: AbnormalFinishReason;
  constructor(reason: AbnormalFinishReason) {
    super(describeAbnormalFinish(reason));
    this.name = "AbnormalFinishError";
    this.reason = reason;
  }
}
