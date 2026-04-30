import { useUIStore } from "../../stores/ui.js";
import { icon } from "../icons.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

function openRepoMapMenu(_ctx: CommandContext): void {
  useUIStore.getState().openModal("repoMapStatus");
}

function openMemoryMenu(ctx: CommandContext): void {
  const memMgr = ctx.contextManager.getMemoryManager();

  const showMain = () => {
    const config = memMgr.scopeConfig;
    const hint = memMgr.cleanupHint();
    const browseDesc = hint
      ? `${String(hint.stale)} stale of ${String(hint.total)} memories — review now`
      : "browse · pin · soft-delete · cleanup";
    ctx.openCommandPicker({
      title: "Memory",
      icon: icon("memory"),
      options: [
        {
          value: "browse",
          label: hint ? "Browse ★" : "Browse",
          description: browseDesc,
          color: hint ? getThemeTokens().warning : undefined,
        },
        {
          value: "write-scope",
          label: "Write Scope",
          description: `where Forge saves new memories (current: ${config.writeScope})`,
        },
        {
          value: "read-scope",
          label: "Read Scope",
          description: `which memories Forge can access (current: ${config.readScope})`,
        },
        {
          value: "settings-storage",
          label: "Save Settings To",
          description: `where these scope preferences are stored (current: ${memMgr.settingsScope})`,
        },
      ],
      onSelect: (value) => {
        if (value === "browse") {
          ctx.openMemoryBrowser();
        } else if (value === "write-scope") {
          ctx.openCommandPicker({
            title: "Write Scope",
            icon: icon("memory"),
            currentValue: memMgr.scopeConfig.writeScope,
            options: [
              {
                value: "global",
                label: "Global",
                description: "shared across all projects (~/.soulforge/)",
              },
              {
                value: "project",
                label: "Project",
                description: "scoped to this project (.soulforge/)",
              },
              { value: "none", label: "None", description: "Forge won't save new memories" },
            ],
            onSelect: (ws) => {
              memMgr.scopeConfig = {
                ...memMgr.scopeConfig,
                writeScope: ws as "global" | "project" | "none",
              };
              sysMsg(ctx, `Memory write scope: ${ws}`);
              showMain();
            },
          });
        } else if (value === "read-scope") {
          ctx.openCommandPicker({
            title: "Read Scope",
            icon: icon("memory"),
            currentValue: memMgr.scopeConfig.readScope,
            options: [
              {
                value: "all",
                label: "All",
                description: "search both project and global memories",
              },
              { value: "global", label: "Global", description: "only access global memories" },
              {
                value: "project",
                label: "Project",
                description: "only access this project's memories",
              },
              {
                value: "none",
                label: "None",
                description: "Forge won't read or auto-recall memories",
              },
            ],
            onSelect: (rs) => {
              memMgr.scopeConfig = {
                ...memMgr.scopeConfig,
                readScope: rs as "global" | "project" | "all" | "none",
              };
              sysMsg(ctx, `Memory read scope: ${rs}`);
              showMain();
            },
          });
        } else if (value === "settings-storage") {
          ctx.openCommandPicker({
            title: "Persist Settings",
            icon: icon("memory"),
            currentValue: memMgr.settingsScope,
            options: [
              {
                value: "project",
                label: "Project",
                description: "scope preferences saved in .soulforge/ (this project only)",
              },
              {
                value: "global",
                label: "Global",
                description: "scope preferences saved in ~/.soulforge/ (apply everywhere)",
              },
            ],
            onSelect: (ss) => {
              memMgr.setSettingsScope(ss as "project" | "global");
              sysMsg(ctx, `Memory settings saved to: ${ss}`);
              showMain();
            },
          });
        }
      },
    });
  };

  showMain();
}

function handleContextClear(input: string, ctx: CommandContext): void {
  const cmd = input.trim().toLowerCase();
  const what = cmd.includes("skills") ? "skills" : cmd.includes("memory") ? "memory" : "all";
  const cleared = ctx.contextManager.clearContext(what as "memory" | "skills" | "all");
  sysMsg(ctx, cleared.length > 0 ? `Cleared: ${cleared.join(", ")}` : "Nothing to clear.");
}

function handleContext(input: string, _ctx: CommandContext): void {
  const cmd = input.trim().toLowerCase();
  const tab = cmd.includes("dispatch")
    ? ("Dispatch" as const)
    : cmd.includes("system")
      ? ("System" as const)
      : ("Context" as const);
  useUIStore.setState({ statusDashboardTab: tab });
  useUIStore.getState().openModal("statusDashboard");
}

function handleDispatchStatus(_input: string, _ctx: CommandContext): void {
  useUIStore.setState({ statusDashboardTab: "Dispatch" });
  useUIStore.getState().openModal("statusDashboard");
}

function handleMemory(_input: string, ctx: CommandContext): void {
  openMemoryMenu(ctx);
}

function handleRepoMap(_input: string, ctx: CommandContext): void {
  openRepoMapMenu(ctx);
}

function handleTools(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("toolsPopup");
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/context", handleContext);
  map.set("/dispatch-status", handleDispatchStatus);
  map.set("/memory", handleMemory);
  map.set("/repo-map", handleRepoMap);
  map.set("/tools", handleTools);
}

export function matchContextPrefix(cmd: string): CommandHandler | null {
  if (cmd.startsWith("/context clear") || cmd === "/context reset") return handleContextClear;
  return null;
}
