/**
 * Cross-platform clipboard text + image I/O.
 *
 * This module is the new home for clipboard logic. `src/utils/clipboard.ts`
 * is kept as a thin re-exporting facade so existing import sites work.
 *
 * Text:
 *   macOS  → pbcopy / pbpaste
 *   Linux  → wl-copy / xclip / xsel
 *   Win32  → clip.exe (write only, fast path); PowerShell Set-Clipboard /
 *            Get-Clipboard (read + write fallback)
 *
 * Image (PNG read):
 *   macOS  → osascript extracting «class PNGf» to a temp file
 *   Linux  → xclip / wl-paste image/png target
 *   Win32  → PowerShell System.Windows.Forms.Clipboard.GetImage().Save()
 */

import { execFile, type SpawnOptions, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { findOnPath, IS_DARWIN, IS_WIN, tmpDir } from "./index.js";

export type ClipboardMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ClipboardImage {
  data: Buffer;
  mediaType: ClipboardMediaType;
}

/**
 * Spawn a backend synchronously, write `text` via stdin, return success.
 * Uses spawnSync so we observe ENOENT (binary missing) instead of the previous
 * fire-and-forget spawn which always returned true — masking missing backends
 * and short-circuiting the fallback chain in writeWindowsText/writeLinuxText.
 */
function trySpawn(cmd: string, args: string[], text: string): boolean {
  try {
    const opts: SpawnOptions & { input: string } = {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      input: text,
    };
    const result = spawnSync(cmd, args, opts);
    if (result.error) return false;
    return result.status === 0;
  } catch {
    return false;
  }
}

// ── Text write ──────────────────────────────────────────────

function writeWindowsText(text: string): boolean {
  // clip.exe is always present on Win10+ and is ~6x faster than PowerShell.
  if (trySpawn("clip", [], text)) return true;
  // Fallback to PowerShell Set-Clipboard if clip.exe is unavailable.
  return trySpawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", "$input | Set-Clipboard"],
    text,
  );
}

function writeLinuxText(text: string): boolean {
  const wayland = !!process.env.WAYLAND_DISPLAY;
  const backends: [string, string[]][] = wayland
    ? [
        ["wl-copy", []],
        ["xclip", ["-selection", "clipboard"]],
        ["xsel", ["-b", "-i"]],
      ]
    : [
        ["xclip", ["-selection", "clipboard"]],
        ["wl-copy", []],
        ["xsel", ["-b", "-i"]],
      ];
  for (const [cmd, args] of backends) {
    if (trySpawn(cmd, args, text)) return true;
  }
  return false;
}

/** Write `text` to the system clipboard. Returns true if a backend was spawned. */
export function copyToClipboard(text: string): boolean {
  if (IS_DARWIN) return trySpawn("pbcopy", [], text);
  if (IS_WIN) return writeWindowsText(text);
  return writeLinuxText(text);
}

// ── Image read ──────────────────────────────────────────────

function cleanup(tmpFile: string): void {
  try {
    unlinkSync(tmpFile);
  } catch {}
}

function readImageDarwin(): Promise<ClipboardImage | null> {
  const tmpFile = join(
    tmpDir(),
    `soulforge-clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );
  // osascript receives the temp path as a -e literal: AppleScript single
  // quotes don't escape, so embed via a `set filePath to POSIX file ...` that
  // takes the path through string concat, not via shell interpolation.
  const script = [
    "try",
    "  set pngData to the clipboard as «class PNGf»",
    `  set filePath to POSIX file "${tmpFile.replace(/"/g, '\\"').replace(/\\/g, "\\\\")}"`,
    "  set fileRef to open for access filePath with write permission",
    "  set eof fileRef to 0",
    "  write pngData to fileRef",
    "  close access fileRef",
    '  return "ok"',
    "on error",
    '  return "no-image"',
    "end try",
  ].join("\n");
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.toString().trim().startsWith("ok")) {
        cleanup(tmpFile);
        resolve(null);
        return;
      }
      try {
        const data = readFileSync(tmpFile);
        unlinkSync(tmpFile);
        if (data.length > 0) {
          resolve({ data, mediaType: "image/png" });
          return;
        }
      } catch {
      } finally {
        cleanup(tmpFile);
      }
      resolve(null);
    });
  });
}

function readImageLinux(): Promise<ClipboardImage | null> {
  return new Promise((resolve) => {
    execFile(
      "xclip",
      ["-selection", "clipboard", "-t", "image/png", "-o"],
      { timeout: 3000, maxBuffer: 20 * 1024 * 1024, encoding: "buffer" },
      (err, stdout) => {
        if (!err && stdout && (stdout as Buffer).length > 0) {
          resolve({ data: stdout as Buffer, mediaType: "image/png" });
          return;
        }
        execFile(
          "wl-paste",
          ["--type", "image/png"],
          { timeout: 3000, maxBuffer: 20 * 1024 * 1024, encoding: "buffer" },
          (err2, stdout2) => {
            if (!err2 && stdout2 && (stdout2 as Buffer).length > 0) {
              resolve({ data: stdout2 as Buffer, mediaType: "image/png" });
              return;
            }
            resolve(null);
          },
        );
      },
    );
  });
}

/**
 * Resolve a usable PowerShell binary on Windows. `execFile` does NOT walk
 * PATHEXT or apply shell resolution, so a bare "powershell" throws ENOENT on
 * machines where only PowerShell 7 (`pwsh`) is installed, or where the child
 * process PATH omits System32. Probe, in order:
 *   1. `powershell` on PATH (Windows PowerShell 5.1, present on most installs)
 *   2. the canonical full path (PATH-independent — survives a stripped PATH)
 *   3. `pwsh` on PATH (PowerShell 7+, the only shell on minimal/Server boxes)
 */
function resolveWindowsPowerShell(): string | null {
  const onPath = findOnPath("powershell");
  if (onPath) return onPath;
  const fullPath = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (existsSync(fullPath)) return fullPath;
  return findOnPath("pwsh");
}

function readImageWindows(): Promise<ClipboardImage | null> {
  const exe = resolveWindowsPowerShell();
  if (!exe) return Promise.resolve(null);
  const tmpFile = join(
    tmpDir(),
    `soulforge-clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );
  // Pass the temp path as a PowerShell parameter so the binder handles
  // quoting. No string interpolation of `tmpFile` into the script body.
  // System.Drawing is NOT auto-loaded in PS 5.1+/7 — must Add-Type explicitly,
  // otherwise [System.Drawing.Imaging.ImageFormat] throws "Unable to find type".
  //
  // GetImage() only returns when the clipboard holds a Bitmap/DIB. Snipping
  // Tool, browsers, and many apps put a raw PNG stream on the clipboard
  // instead — GetImage() returns $null for those. Try the "PNG" data format
  // first (write its bytes straight through) and fall back to GetImage().
  const ps = [
    "param([Parameter(Mandatory)][string]$OutFile)",
    "$ErrorActionPreference = 'SilentlyContinue';",
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$png = [System.Windows.Forms.Clipboard]::GetData('PNG');",
    "if ($png -is [System.IO.MemoryStream]) {",
    "  [System.IO.File]::WriteAllBytes($OutFile, $png.ToArray());",
    "  Write-Output 'ok'; exit 0;",
    "}",
    "$img = [System.Windows.Forms.Clipboard]::GetImage();",
    "if ($img -eq $null) { Write-Output 'no-image'; exit 0 };",
    "$img.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png);",
    "Write-Output 'ok'",
  ].join(" ");
  return new Promise((resolve) => {
    execFile(
      exe,
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", ps, "-OutFile", tmpFile],
      // Cold PowerShell pays an Add-Type JIT cost; 5s overran on slow boxes.
      { timeout: 10000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout.toString().trim().startsWith("ok")) {
          cleanup(tmpFile);
          resolve(null);
          return;
        }
        try {
          const data = readFileSync(tmpFile);
          unlinkSync(tmpFile);
          if (data.length > 0) {
            resolve({ data, mediaType: "image/png" });
            return;
          }
        } catch {
        } finally {
          cleanup(tmpFile);
        }
        resolve(null);
      },
    );
  });
}

/** Read a PNG image from the clipboard. Returns null if none present. */
export function readClipboardImage(): Promise<ClipboardImage | null> {
  if (IS_DARWIN) return readImageDarwin();
  if (IS_WIN) return readImageWindows();
  return readImageLinux();
}
