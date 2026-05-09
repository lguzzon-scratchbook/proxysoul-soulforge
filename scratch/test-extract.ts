import { generateText } from "ai";
import { resolveModel } from "../src/core/llm/provider.js";
import { MemoryExtractor } from "../src/core/memory/extractor.js";

const modelId = process.argv[2] ?? "anthropic/claude-haiku-4-5";
const model = resolveModel(modelId);

const cases = [
  {
    name: "decision turn",
    user: "let's switch to bun, npm is too slow on this machine",
    assistant:
      "Updated package.json scripts to use bun. The 47 npm scripts now run via `bun run`. Removed the npm-only postinstall hook since bun handles it natively. Build time dropped from 18s to 2.3s.",
  },
  {
    name: "preference turn",
    user: "be more terse please, you're using too many words",
    assistant:
      "Got it. Will keep replies short — fragments over sentences, no preamble. Will save you tokens.",
  },
  {
    name: "gotcha turn",
    user: "the JWT keeps expiring randomly in prod",
    assistant:
      "Found it. `jwt.ts:47` uses `Date.now()` for expiry but the prod container's clock drifts ~3min/day. Switched to `process.hrtime.bigint()` and synced via NTP at boot. Also added a 5min grace window. Tested with clock skew up to 10min — holds.",
  },
  {
    name: "code-only turn (should extract little or nothing)",
    user: "rename foo to bar in src/",
    assistant: "Renamed. 14 files updated. Tests pass.",
  },
  {
    name: "context turn",
    user: "FYI the legacy/ folder is being deleted next sprint, don't add anything there",
    assistant: "Noted — will route new code to core/ instead.",
  },
  {
    name: "noise turn",
    user: "thanks!",
    assistant: "You're welcome. Let me know if anything else comes up.",
  },
];

const extractor = new MemoryExtractor(async (prompt) => {
  try {
    const r = await generateText({ model, prompt, maxOutputTokens: 1024 });
    if (process.env.DEBUG) console.log("RAW:", r.text.slice(0, 500));
    return r.text;
  } catch (e) {
    console.error("MODEL ERROR:", e instanceof Error ? e.message : String(e));
    throw e;
  }
});

for (const c of cases) {
  console.log(`\n--- ${c.name} ---`);
  console.log(`user:      ${c.user}`);
  console.log(
    `assistant: ${c.assistant.slice(0, 80)}${c.assistant.length > 80 ? "..." : ""}`,
  );
  const t0 = Date.now();
  const proposals = await extractor.proposeFromTurn(c.user, c.assistant);
  const dt = Date.now() - t0;
  console.log(`-> ${proposals.length} proposal(s) in ${dt}ms:`);
  for (const p of proposals) {
    console.log(`   [${p.category ?? "-"}] ${p.summary}`);
    if (p.details)
      console.log(
        `      ${p.details.slice(0, 100)}${p.details.length > 100 ? "..." : ""}`,
      );
    if (p.topics.length) console.log(`      topics: ${p.topics.join(", ")}`);
    if (p.file_paths.length) console.log(`      files: ${p.file_paths.join(", ")}`);
  }
}
