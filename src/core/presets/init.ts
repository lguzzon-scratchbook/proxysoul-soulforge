import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, setPresetOverlay } from "../../config/index.js";
import { logBackgroundError } from "../../stores/errors.js";
import type { AppConfig } from "../../types/index.js";
import { resolvePresets, type ResolvePresetsResult } from "./loader.js";
import { mergePresetsIntoConfig } from "./merge.js";

function getGlobalConfigFile(): string {
  return join(process.env.HOME ?? homedir(), ".soulforge", "config.json");
}

export interface PresetsInitOptions {
  cwd?: string;
  onStatus?: (msg: string) => void;
}

export interface PresetsInitReport {
  specs: string[];
  ok: string[];
  failed: Array<{ spec: string; error: string }>;
  fromGlobal: number;
  fromProject: number;
  fromCli: number;
}

function readPresetSpecs(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const cfg = JSON.parse(readFileSync(file, "utf-8")) as { presets?: unknown };
    if (Array.isArray(cfg.presets)) {
      return cfg.presets.filter((s): s is string => typeof s === "string" && s.length > 0);
    }
  } catch {}
  return [];
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Resolve presets from:
 *   1. ~/.soulforge/config.json `presets[]` (global)
 *   2. <cwd>/.soulforge/config.json `presets[]` (project, overrides global)
 *   3. SOULFORGE_PRESETS env (set from --plugin flags, ephemeral, wins last)
 *
 * Order = precedence (later wins). Failures are logged, not fatal:
 * one bad preset never blocks boot.
 */
export async function initPresetsFromEnv(
  opts: PresetsInitOptions = {},
): Promise<PresetsInitReport> {
  const cwd = opts.cwd ?? process.cwd();
  const projectFile = join(cwd, ".soulforge", "config.json");

  const globalSpecs = readPresetSpecs(getGlobalConfigFile());
  const projectSpecs = readPresetSpecs(projectFile);
  const cliSpecs = (process.env.SOULFORGE_PRESETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const specs = dedupe([...globalSpecs, ...projectSpecs, ...cliSpecs]);

  const report: PresetsInitReport = {
    specs,
    ok: [],
    failed: [],
    fromGlobal: globalSpecs.length,
    fromProject: projectSpecs.length,
    fromCli: cliSpecs.length,
  };

  if (specs.length === 0) return report;

  opts.onStatus?.(`Loading ${specs.length} preset${specs.length === 1 ? "" : "s"}`);

  let result: ResolvePresetsResult;
  try {
    result = await resolvePresets(specs, {
      onProgress: (spec, status, detail) => {
        if (status === "ok") {
          opts.onStatus?.(`  ok    ${spec} (${detail?.source ?? "?"})`);
        } else {
          opts.onStatus?.(`  fail  ${spec}: ${detail?.error ?? "unknown"}`);
        }
      },
    });
  } catch (err) {
    logBackgroundError(
      "presets",
      `Preset resolution crashed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return report;
  }

  report.ok = result.resolved.map((r) => r.preset.name);
  report.failed = result.failures;

  for (const f of result.failures) {
    logBackgroundError("presets", `Preset "${f.spec}" failed: ${f.error}`);
  }

  if (result.resolved.length === 0) return report;

  try {
    const baseline: AppConfig = { ...DEFAULT_CONFIG };
    const merged = mergePresetsIntoConfig(
      baseline,
      result.resolved.map((r) => r.preset),
    );
    // Diff merged against DEFAULT_CONFIG to get the overlay patch.
    const overlay: Partial<AppConfig> = {};
    const mergedRec = merged as unknown as Record<string, unknown>;
    const defaultsRec = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    for (const key of Object.keys(mergedRec)) {
      if (JSON.stringify(mergedRec[key]) !== JSON.stringify(defaultsRec[key])) {
        (overlay as Record<string, unknown>)[key] = mergedRec[key];
      }
    }
    setPresetOverlay(overlay);
  } catch (err) {
    logBackgroundError(
      "presets",
      `Preset merge failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return report;
}
