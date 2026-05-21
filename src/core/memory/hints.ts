/**
 * Inline memory hints — surface a top memory summary + count alongside tool
 * results that touch files, topics, or query terms with linked memories.
 * Encourages the agent to lean on memory search naturally without spending
 * tokens on a search call.
 *
 * Wired by ContextManager via setMemoryHintProvider; tools call
 * memoryHintForPaths / memoryHintForTopics / memoryHintForQuery /
 * memoryHintComposite — fast SQLite lookups, zero awaited I/O on the read-only
 * path. All helpers swallow errors and report to /errors so a memory failure
 * never crashes a tool.
 *
 * Per-turn dedup: each surfaced memory ID is tracked. Repeat fires of the same
 * top memory in the same turn fall back to a bare count to save tokens.
 * `resetSurfacedHints()` is called on cache reset (/clear, compaction).
 */
import { logBackgroundError } from "../../stores/errors.js";
import type { MemoryManager } from "./manager.js";

let _manager: MemoryManager | null = null;
const _surfacedThisTurn = new Set<string>();

const SUMMARY_MAX = 60;

export function setMemoryHintProvider(manager: MemoryManager | null): void {
  _manager = manager;
}

/** Called on /clear, compaction, session restore — flushes per-turn dedup state. */
export function resetSurfacedHints(): void {
  _surfacedThisTurn.clear();
}

function reportHintError(scope: string, err: unknown): void {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    logBackgroundError(`memory-hint:${scope}`, msg);
  } catch {
    // never throw from hint path
  }
}

function truncateSummary(s: string): string {
  if (s.length <= SUMMARY_MAX) return s;
  return `${s.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
}

/**
 * Build a rich hint line:
 *   first fire of top:  · "Commit body: short bullets" +2
 *   pinned variant:     · pinned: "Never force push" +4
 *   repeat (dedup):     · 3 memories
 *   only 1 memory:      · "Commit body: short bullets"
 * Returns "" when total is 0.
 */
function buildHintLine(
  top: { id: string; summary: string; pinned: boolean } | null,
  total: number,
): string {
  if (total <= 0) return "";
  if (!top) return total === 1 ? "\n· 1 memory" : `\n· ${String(total)} memories`;

  // Dedup: top already shown this turn → fall back to bare count.
  if (_surfacedThisTurn.has(top.id)) {
    return total === 1 ? "\n· 1 memory" : `\n· ${String(total)} memories`;
  }
  _surfacedThisTurn.add(top.id);

  const prefix = top.pinned ? "pinned: " : "";
  const summary = truncateSummary(top.summary);
  const rest = total - 1;
  const more = rest > 0 ? ` +${String(rest)}` : "";
  return `\n· ${prefix}"${summary}"${more}`;
}

/**
 * Count memories whose file_refs intersect the given relative paths.
 * Returns 0 if no manager wired, or the paths array is empty.
 * Safe to call from any tool — never throws.
 */
export function countMemoriesForPaths(paths: string[]): number {
  if (!_manager || paths.length === 0) return 0;
  try {
    const projectDb = _manager.getDbForScope("project");
    const globalDb = _manager.getDbForScope("global");
    const ids = new Set<string>();
    for (const id of projectDb.findByPaths(paths, 100)) ids.add(id);
    for (const id of globalDb.findByPaths(paths, 100)) ids.add(id);
    return ids.size;
  } catch (err) {
    reportHintError("paths", err);
    return 0;
  }
}

/**
 * Count memories whose `topics` json array intersects any of the given tags.
 * Useful for cross-cutting prefs without natural file paths (e.g. "git",
 * "commit", "lint", "style"). Never throws.
 */
export function countMemoriesForTopics(topics: string[]): number {
  if (!_manager || topics.length === 0) return 0;
  try {
    const projectDb = _manager.getDbForScope("project");
    const globalDb = _manager.getDbForScope("global");
    const ids = new Set<string>();
    for (const id of projectDb.findByTopics(topics, 100)) ids.add(id);
    for (const id of globalDb.findByTopics(topics, 100)) ids.add(id);
    return ids.size;
  } catch (err) {
    reportHintError("topics", err);
    return 0;
  }
}

/**
 * Count memories matching a free-form query via FTS (unicode + trigram).
 * Returns the deduped count across both scopes. Never throws.
 */
export function countMemoriesForQuery(query: string): number {
  if (!_manager || !query || query.trim().length === 0) return 0;
  try {
    const projectDb = _manager.getDbForScope("project");
    const globalDb = _manager.getDbForScope("global");
    const ids = new Set<string>();
    for (const hit of projectDb.searchUnicode(query, 25)) ids.add(hit.id);
    for (const hit of projectDb.searchTrigram(query, 25)) ids.add(hit.id);
    for (const hit of globalDb.searchUnicode(query, 25)) ids.add(hit.id);
    for (const hit of globalDb.searchTrigram(query, 25)) ids.add(hit.id);
    return ids.size;
  } catch (err) {
    reportHintError("query", err);
    return 0;
  }
}

/**
 * Format a one-line hint. Returns empty string when count === 0 so callers
 * can unconditionally concatenate.
 */
export function formatMemoryHint(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "\n· 1 memory" : `\n· ${String(count)} memories`;
}

/**
 * Convenience: count + format in one call. Returns "" when nothing linked.
 */
export function memoryHintForPaths(paths: string[]): string {
  return formatMemoryHint(countMemoriesForPaths(paths));
}

export function memoryHintForTopics(topics: string[]): string {
  return formatMemoryHint(countMemoriesForTopics(topics));
}

export function memoryHintForQuery(query: string): string {
  return formatMemoryHint(countMemoriesForQuery(query));
}

/**
 * Composite hint — dedup across paths + topics + query, ranks the best
 * memory (pinned > recent > used) and inlines its summary. Repeats within
 * the same turn fall back to a bare count. Single tail line.
 * Never throws; falls back to "" on error.
 */
export function memoryHintComposite(opts: {
  paths?: string[];
  topics?: string[];
  query?: string;
}): string {
  if (!_manager) return "";
  try {
    const projectDb = _manager.getDbForScope("project");
    const globalDb = _manager.getDbForScope("global");

    // Combine candidate IDs across both scopes.
    const ids = new Set<string>();
    if (opts.paths && opts.paths.length > 0) {
      for (const id of projectDb.findByPaths(opts.paths, 100)) ids.add(id);
      for (const id of globalDb.findByPaths(opts.paths, 100)) ids.add(id);
    }
    if (opts.topics && opts.topics.length > 0) {
      for (const id of projectDb.findByTopics(opts.topics, 100)) ids.add(id);
      for (const id of globalDb.findByTopics(opts.topics, 100)) ids.add(id);
    }
    if (opts.query && opts.query.trim().length > 0) {
      for (const hit of projectDb.searchUnicode(opts.query, 25)) ids.add(hit.id);
      for (const hit of projectDb.searchTrigram(opts.query, 25)) ids.add(hit.id);
      for (const hit of globalDb.searchUnicode(opts.query, 25)) ids.add(hit.id);
      for (const hit of globalDb.searchTrigram(opts.query, 25)) ids.add(hit.id);
    }

    const total = ids.size;
    if (total === 0) return "";

    // Rank: query both scopes for top candidate, pick the better one.
    const projectTop = projectDb.topRecallFor(opts, 1);
    const globalTop = globalDb.topRecallFor(opts, 1);
    let top: { id: string; summary: string; pinned: boolean } | null = null;
    const candidates = [...projectTop, ...globalTop];
    for (const c of candidates) {
      if (!top) {
        top = c;
        continue;
      }
      // Prefer pinned; otherwise leave existing (already last_used_at sorted).
      if (c.pinned && !top.pinned) top = c;
    }

    return buildHintLine(top, total);
  } catch (err) {
    reportHintError("composite", err);
    return "";
  }
}
