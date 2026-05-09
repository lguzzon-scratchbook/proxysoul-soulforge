/**
 * Phase 6 — post-turn extraction (opt-in).
 *
 * After an agent turn finishes, optionally scan the user's prompt + assistant
 * reply for durable, non-code knowledge worth remembering, and propose
 * candidate memories to the user. The model never writes directly — it
 * returns a JSON array; the user confirms via UI/CLI.
 *
 * Contract:
 * - Disabled by default. AppConfig.memory.postTurnExtraction.enabled gates it.
 * - Provider-agnostic: caller supplies a `complete(prompt) => Promise<string>`
 *   adapter so we don't import the LLM stack here.
 * - Failure modes (network, timeout, JSON parse, empty) all collapse to []
 *   — extraction is best-effort, never blocking.
 */

import type { MemoryCategory } from "./types.js";

export interface ExtractedProposal {
  summary: string;
  details: string;
  category: MemoryCategory | null;
  topics: string[];
  file_paths: string[];
}

export interface PendingProposal extends ExtractedProposal {
  id: string;
  proposed_at: string;
  source_session_id: string | null;
  source_turn_index: number | null;
}

export type ModelComplete = (prompt: string) => Promise<string>;

const PROMPT = `You will be given a user message and an assistant reply from a coding session.
Extract at most 3 DURABLE, NON-CODE memories worth remembering across sessions.

What counts:
- user preferences ("user wants terse output")
- decisions with rationale ("we use bun, not node, because…")
- gotchas ("jwt.ts secrets must rotate every 90d")
- project context ("legacy/ is replaced by core/ next sprint")

What does NOT count:
- anything visible from the codebase (file/symbol/signature) — Soul Map handles those
- one-shot facts that won't matter next session
- the conversation itself

Return ONLY a JSON array. Each element:
{
  "summary": "<≤200ch headline>",
  "details": "<≤2000ch context, can be empty>",
  "category": "pref" | "decision" | "gotcha" | "context" | null,
  "topics": ["<≤8 tags>"],
  "file_paths": ["<relative paths if specifically about these files>"]
}

If nothing qualifies, return []. No prose. No markdown fence. Just the array.

---
USER:
%USER%

---
ASSISTANT:
%ASSISTANT%
---`;

const SUMMARY_MAX = 200;
const DETAILS_MAX = 2000;
const TOPICS_MAX = 8;
const FILES_MAX = 16;

export class MemoryExtractor {
  constructor(private readonly complete: ModelComplete) {}

  async proposeFromTurn(
    userMessage: string,
    assistantMessage: string,
  ): Promise<ExtractedProposal[]> {
    const prompt = PROMPT.replace("%USER%", userMessage.trim()).replace(
      "%ASSISTANT%",
      assistantMessage.trim(),
    );
    let raw: string;
    try {
      raw = await this.complete(prompt);
    } catch {
      return [];
    }
    return parseProposals(raw);
  }
}

export function parseProposals(raw: string): ExtractedProposal[] {
  const trimmed = stripFence(raw).trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ExtractedProposal[] = [];
  for (const item of parsed) {
    const norm = normalizeProposal(item);
    if (norm) out.push(norm);
    if (out.length >= 3) break;
  }
  return out;
}

function stripFence(s: string): string {
  // Models occasionally wrap in ```json ... ``` even when told not to.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? (fenced[1] ?? s) : s;
}

function normalizeProposal(item: unknown): ExtractedProposal | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const summary = typeof o.summary === "string" ? o.summary.trim().slice(0, SUMMARY_MAX) : "";
  if (!summary) return null;
  const details = typeof o.details === "string" ? o.details.trim().slice(0, DETAILS_MAX) : "";
  const category = isCategory(o.category) ? o.category : null;
  const topics: string[] = [];
  if (Array.isArray(o.topics)) {
    for (const t of o.topics) {
      if (typeof t !== "string") continue;
      const trimmed = t.trim().slice(0, 32);
      if (trimmed) topics.push(trimmed);
      if (topics.length >= TOPICS_MAX) break;
    }
  }
  const filePaths: string[] = [];
  if (Array.isArray(o.file_paths)) {
    for (const p of o.file_paths) {
      if (typeof p !== "string") continue;
      const trimmed = p.trim();
      if (trimmed) filePaths.push(trimmed);
      if (filePaths.length >= FILES_MAX) break;
    }
  }
  return { summary, details, category, topics, file_paths: filePaths };
}

function isCategory(v: unknown): v is MemoryCategory {
  return v === "pref" || v === "decision" || v === "gotcha" || v === "context";
}
