/**
 * First-run addon wizard.
 *
 * Runs once before the TUI mounts, on every install channel (brew, npm,
 * tarball, Windows zip, NSIS). Asks the user whether to download CLIProxyAPI
 * and/or Neovim — both opt-in addons that aren't bundled.
 *
 * Skip conditions:
 *  - Already shown (config.addonsPromptShown === true)
 *  - Non-TTY stdin/stdout (CI, pipes, redirected)
 *  - SOULFORGE_NO_PROMPT=1 (explicit opt-out)
 *  - --headless or any flag that short-circuits the TUI (handled in boot.tsx
 *    before this is called)
 *  - Already-installed addons are dropped from the option list — if both are
 *    installed already, the wizard is a no-op flag-flip.
 *
 * On Ctrl+C / Esc / empty pick: still set the flag so we don't ask again.
 * User can re-trigger with `soulforge addon install <name>` any time.
 */

import { loadConfig, saveGlobalConfig } from "../../config/index.js";
import { type AddonName, installAddon, isAddonInstalled } from "./addons.js";

interface AddonOption {
  value: AddonName;
  label: string;
  hint: string;
}

const OPTIONS: AddonOption[] = [
  {
    value: "proxy",
    label: "CLIProxyAPI",
    hint: "multi-provider LLM gateway (~25 MB)",
  },
  {
    value: "neovim",
    label: "Neovim",
    hint: "editor integration (~15 MB)",
  },
];

export function shouldRunAddonWizard(): boolean {
  if (process.env.SOULFORGE_NO_PROMPT === "1") return false;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  const cfg = loadConfig();
  if (cfg.addonsPromptShown === true) return false;
  // No remaining options to offer — skip and flip the flag below in run().
  const remaining = OPTIONS.filter((o) => !isAddonInstalled(o.value));
  if (remaining.length === 0) {
    // Mark as shown so we don't re-check every launch.
    saveGlobalConfig({ addonsPromptShown: true });
    return false;
  }
  return true;
}

export async function runAddonWizard(): Promise<void> {
  // Defensive — caller should have checked, but a stray invocation should not
  // hang in a non-TTY (clack reads stdin).
  if (!process.stdout.isTTY || !process.stdin.isTTY) return;

  // Lazy-load clack so non-wizard boots don't pay the import cost.
  const p = await import("@clack/prompts");

  const remaining = OPTIONS.filter((o) => !isAddonInstalled(o.value));
  if (remaining.length === 0) {
    saveGlobalConfig({ addonsPromptShown: true });
    return;
  }

  p.intro("soulforge — optional addons");
  p.log.message(
    "These are NOT bundled with soulforge. Pick any you want now; you can\n" +
      "  install or remove them later with `soulforge addon install|remove <name>`.",
  );

  // One yes/no per addon — clearer than multiselect (Enter alone on a
  // multiselect submits an empty pick and silently skips everything).
  const picked: AddonName[] = [];
  for (const opt of remaining) {
    const answer = await p.confirm({
      message: `Install ${opt.label}? — ${opt.hint}`,
      initialValue: false,
    });
    if (p.isCancel(answer)) {
      // Ctrl+C / Esc — bail out of the wizard entirely, record we asked.
      saveGlobalConfig({ addonsPromptShown: true });
      p.outro("Cancelled — install later with `soulforge addon install <name>`");
      return;
    }
    if (answer === true) picked.push(opt.value);
  }

  // Always record that we asked, regardless of outcome — don't nag.
  saveGlobalConfig({ addonsPromptShown: true });

  if (picked.length === 0) {
    p.outro("Skipped — install later with `soulforge addon install <name>`");
    return;
  }

  for (const name of picked) {
    const spin = p.spinner();
    spin.start(`Installing ${name}…`);
    try {
      await installAddon(name, (msg) => spin.message(msg));
      spin.stop(`${name} installed`);
    } catch (err) {
      spin.stop(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  p.outro("Done — launching soulforge");
}
