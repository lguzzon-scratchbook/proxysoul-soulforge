import { describe, expect, test } from "bun:test";

// Wave 1 invariant: a frozen soul-map snapshot returns byte-identical content
// for its entire TTL window, regardless of file-change activity in between.
// Mutations land in the delta channel — never in the snapshot.

interface FrozenSnapshot {
  content: string;
  at: number;
  hash: string;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function createSnapshotHarness(opts: { ttlMs: number; deltaBudget: number }) {
  let snapshot: FrozenSnapshot | null = null;
  const deltas: string[] = [];
  let pendingDeltaBytes = 0;
  let renderedContent = "initial render";
  let now = 0;

  return {
    setNow(t: number) {
      now = t;
    },
    setRenderedContent(c: string) {
      renderedContent = c;
    },
    pushDelta(text: string) {
      deltas.push(text);
      pendingDeltaBytes += text.length;
    },
    getSnapshot(forceRefresh = false): string {
      const ttlExpired = !snapshot || now - snapshot.at >= opts.ttlMs;
      const budgetExceeded = pendingDeltaBytes > opts.deltaBudget;
      const shouldRefresh = forceRefresh || ttlExpired || budgetExceeded;
      if (!shouldRefresh && snapshot) return snapshot.content;
      snapshot = { content: renderedContent, at: now, hash: fnv1a(renderedContent) };
      deltas.length = 0;
      pendingDeltaBytes = 0;
      return snapshot.content;
    },
    snapshotHash() {
      return snapshot?.hash ?? null;
    },
    deltaCount() {
      return deltas.length;
    },
    deltaBytes() {
      return pendingDeltaBytes;
    },
  };
}

describe("Wave 1 — soul map snapshot stability", () => {
  test("snapshot bytes identical across 100 file changes within TTL", () => {
    const h = createSnapshotHarness({ ttlMs: 600_000, deltaBudget: 16_000 });
    h.setNow(0);
    const first = h.getSnapshot();
    const firstHash = h.snapshotHash();

    // Simulate 100 file changes — each pushes a small delta, never refreshes.
    for (let i = 0; i < 100; i++) {
      h.setNow(i * 1000); // 100s of activity
      h.pushDelta(`file-${String(i)}.ts:`);
    }

    const last = h.getSnapshot();
    expect(last).toBe(first);
    expect(h.snapshotHash()).toBe(firstHash);
    expect(h.deltaCount()).toBe(100);
  });

  test("snapshot refreshes after TTL expiry, deltas drop", () => {
    const h = createSnapshotHarness({ ttlMs: 60_000, deltaBudget: 16_000 });
    h.setNow(0);
    h.setRenderedContent("snapshot v1");
    const v1 = h.getSnapshot();
    expect(v1).toBe("snapshot v1");

    h.pushDelta("modified");
    expect(h.deltaCount()).toBe(1);

    // Cross TTL boundary
    h.setNow(60_001);
    h.setRenderedContent("snapshot v2");
    const v2 = h.getSnapshot();
    expect(v2).toBe("snapshot v2");
    expect(h.deltaCount()).toBe(0); // deltas folded into new snapshot
  });

  test("delta budget overflow forces snapshot refresh before TTL", () => {
    const h = createSnapshotHarness({ ttlMs: 600_000, deltaBudget: 100 });
    h.setNow(0);
    h.setRenderedContent("snapshot v1");
    h.getSnapshot();

    // Push deltas totalling more than budget
    h.pushDelta("a".repeat(50));
    h.pushDelta("b".repeat(60)); // total 110, > 100
    expect(h.deltaBytes()).toBeGreaterThan(100);

    h.setRenderedContent("snapshot v2");
    const refreshed = h.getSnapshot();
    expect(refreshed).toBe("snapshot v2");
    expect(h.deltaCount()).toBe(0);
  });

  test("explicit refresh always rebuilds, even before TTL", () => {
    const h = createSnapshotHarness({ ttlMs: 600_000, deltaBudget: 16_000 });
    h.setNow(0);
    h.setRenderedContent("snapshot v1");
    const v1 = h.getSnapshot();
    const h1 = h.snapshotHash();

    h.setRenderedContent("snapshot v2");
    const v2 = h.getSnapshot(true);
    expect(v2).toBe("snapshot v2");
    expect(v2).not.toBe(v1);
    expect(h.snapshotHash()).not.toBe(h1);
  });

  test("snapshot hash is deterministic across runs for same content", () => {
    const a = fnv1a("hello world");
    const b = fnv1a("hello world");
    expect(a).toBe(b);
    expect(a).toBe("d58b3fa7");
  });

  test("byte-stable ordering: sort by recency DESC then path ASC for ties", () => {
    const entries: Array<[string, number]> = [
      ["c.ts", 5],
      ["a.ts", 5],
      ["b.ts", 3],
    ];
    const sorted = entries.sort((x, y) => {
      const recency = y[1] - x[1];
      return recency !== 0 ? recency : x[0].localeCompare(y[0]);
    });
    expect(sorted.map(([p]) => p)).toEqual(["a.ts", "c.ts", "b.ts"]);
  });
});
