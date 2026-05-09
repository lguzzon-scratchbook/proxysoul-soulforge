/**
 * Pending-proposals store. Persists Phase 6 extraction proposals on disk
 * so they survive process restarts. User accepts/rejects via UI; only on
 * accept does the proposal become a real memory.
 *
 * Single JSON file per scope (project) — small N (≤50 entries), no need
 * for SQLite. Atomic write via tmp+rename.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PendingProposal } from "./extractor.js";

const FILE = "memory-pending.json";
const MAX_PENDING = 50;

export class PendingStore {
  private items: PendingProposal[] = [];
  private path: string;
  private loaded = false;

  constructor(cwd: string) {
    this.path = join(cwd, ".soulforge", FILE);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        this.items = parsed.filter(isPendingProposal);
      }
    } catch {
      this.items = [];
    }
  }

  list(): PendingProposal[] {
    this.ensureLoaded();
    return [...this.items];
  }

  add(p: PendingProposal): void {
    this.ensureLoaded();
    this.items.unshift(p);
    if (this.items.length > MAX_PENDING) this.items.length = MAX_PENDING;
    this.flush();
  }

  remove(id: string): boolean {
    this.ensureLoaded();
    const before = this.items.length;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.items.length === before) return false;
    this.flush();
    return true;
  }

  get(id: string): PendingProposal | null {
    this.ensureLoaded();
    return this.items.find((p) => p.id === id) ?? null;
  }

  clear(): number {
    this.ensureLoaded();
    const n = this.items.length;
    this.items = [];
    this.flush();
    return n;
  }

  private flush(): void {
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.items, null, 2), "utf-8");
      renameSync(tmp, this.path);
    } catch {}
  }
}

function isPendingProposal(v: unknown): v is PendingProposal {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.summary === "string" &&
    typeof o.details === "string" &&
    Array.isArray(o.topics) &&
    Array.isArray(o.file_paths) &&
    typeof o.proposed_at === "string"
  );
}
