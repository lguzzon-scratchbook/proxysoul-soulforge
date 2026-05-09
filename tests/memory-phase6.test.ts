import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MemoryExtractor, parseProposals } from "../src/core/memory/extractor.js";
import { MemoryManager } from "../src/core/memory/manager.js";
import { PendingStore } from "../src/core/memory/pending.js";

function makeTmpDir(label: string): string {
  const dir = join(
    tmpdir(),
    `mem-phase6-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".soulforge"), { recursive: true });
  return dir;
}

describe("MemoryExtractor — parsing", () => {
  it("parses plain JSON array", () => {
    const raw = `[{"summary":"use bun","details":"","category":"decision","topics":["tooling"],"file_paths":[]}]`;
    const out = parseProposals(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.summary).toBe("use bun");
    expect(out[0]!.category).toBe("decision");
  });

  it("strips markdown fences", () => {
    const raw = "```json\n[{\"summary\":\"hello\",\"details\":\"\",\"category\":null,\"topics\":[],\"file_paths\":[]}]\n```";
    const out = parseProposals(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.summary).toBe("hello");
  });

  it("returns [] on garbage", () => {
    expect(parseProposals("")).toEqual([]);
    expect(parseProposals("not json")).toEqual([]);
    expect(parseProposals("{not array}")).toEqual([]);
  });

  it("caps at 3 proposals", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      summary: `s${i}`,
      details: "",
      category: null,
      topics: [],
      file_paths: [],
    }));
    const raw = JSON.stringify(items);
    expect(parseProposals(raw)).toHaveLength(3);
  });

  it("rejects items without summary", () => {
    const raw = `[{"details":"no summary"},{"summary":"ok","details":"","category":null,"topics":[],"file_paths":[]}]`;
    const out = parseProposals(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.summary).toBe("ok");
  });

  it("normalizes invalid category to null", () => {
    const raw = `[{"summary":"x","details":"","category":"made-up","topics":[],"file_paths":[]}]`;
    const out = parseProposals(raw);
    expect(out[0]!.category).toBeNull();
  });

  it("uses injected ModelComplete adapter", async () => {
    const stub = async () =>
      `[{"summary":"stub-extracted","details":"d","category":"context","topics":["t"],"file_paths":[]}]`;
    const ex = new MemoryExtractor(stub);
    const out = await ex.proposeFromTurn("user msg", "assistant reply");
    expect(out).toHaveLength(1);
    expect(out[0]!.summary).toBe("stub-extracted");
  });

  it("collapses model errors to []", async () => {
    const failing = async () => {
      throw new Error("network down");
    };
    const ex = new MemoryExtractor(failing);
    expect(await ex.proposeFromTurn("a", "b")).toEqual([]);
  });
});

describe("PendingStore — persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir("pending");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("survives reopen", () => {
    const a = new PendingStore(dir);
    a.add({
      id: "p-1",
      summary: "test",
      details: "",
      category: null,
      topics: [],
      file_paths: [],
      proposed_at: new Date().toISOString(),
      source_session_id: null,
      source_turn_index: null,
    });
    const b = new PendingStore(dir);
    expect(b.list()).toHaveLength(1);
    expect(b.list()[0]!.id).toBe("p-1");
  });

  it("remove drops the entry", () => {
    const s = new PendingStore(dir);
    s.add({
      id: "p-1",
      summary: "x",
      details: "",
      category: null,
      topics: [],
      file_paths: [],
      proposed_at: new Date().toISOString(),
      source_session_id: null,
      source_turn_index: null,
    });
    expect(s.remove("p-1")).toBe(true);
    expect(s.list()).toHaveLength(0);
  });
});

describe("MemoryManager — accept/reject pending", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir("mgr");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("addPending → accept writes a real memory and removes pending", () => {
    const mgr = new MemoryManager(dir);
    try {
      const added = mgr.addPending(
        [
          {
            summary: "from-extraction",
            details: "rationale",
            category: "decision",
            topics: ["t1"],
            file_paths: ["src/foo.ts"],
          },
        ],
        "session-x",
        2,
      );
      expect(added).toHaveLength(1);
      expect(mgr.listPending()).toHaveLength(1);

      const record = mgr.acceptPending(added[0]!.id, "project");
      expect(record).not.toBeNull();
      expect(record!.summary).toBe("from-extraction");
      expect(record!.session_id).toBe("session-x");
      expect(mgr.listPending()).toHaveLength(0);

      // file_paths attached
      const refs = mgr.listFileRefs("project", record!.id);
      expect(refs.map((r) => r.path)).toContain("src/foo.ts");
    } finally {
      mgr.close();
    }
  });

  it("rejectPending discards without writing", () => {
    const mgr = new MemoryManager(dir);
    try {
      const added = mgr.addPending(
        [
          {
            summary: "ignore-me",
            details: "",
            category: null,
            topics: [],
            file_paths: [],
          },
        ],
        null,
        null,
      );
      expect(mgr.rejectPending(added[0]!.id)).toBe(true);
      expect(mgr.listPending()).toHaveLength(0);
      expect(mgr.list("project").length).toBe(0);
    } finally {
      mgr.close();
    }
  });
});
