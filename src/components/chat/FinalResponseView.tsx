import { TextAttributes } from "@opentui/core";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import { resolveToolDisplay, TOOL_LABELS_DONE } from "../../core/tool-display.js";
import { garble } from "../../core/utils/splash.js";
import { formatElapsed } from "../../hooks/useElapsed.js";
import { useHover } from "../../hooks/useHover.js";
import { Spinner } from "../layout/shared.js";
import { ImageDisplay } from "./ImageDisplay.js";
import { DripText, type StreamSegment } from "./StreamSegmentList.js";
import {
  DispatchSubtree,
  type LiveToolCall,
  SUBAGENT_NAMES,
  TREE_PIPE,
  TREE_SPACE,
} from "./ToolCallDisplay.js";
import { formatArgs } from "./tool-formatters.js";

export const FINAL_RESPONSE_EDIT_TOOLS = new Set([
  "edit_file",
  "multi_edit",
  "ast_edit",
  "write_file",
  "create_file",
  "rename_file",
  "move_symbol",
  "rename_symbol",
]);

const QUIET_TOOLS = new Set(["update_plan_step", "ask_user", "task_list", "final_response"]);

const MAX_VISIBLE = 5;
const ROTATE_INTERVAL = 8000;
const GLITCH_FRAMES = 3;
const GLITCH_TICK = 70;

// Phase-specific spinners for tool-rail status header
const SPIN_EXPLORE = ["◴", "◷", "◶", "◵"];
const SPIN_EDIT = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█", "▉", "▊", "▋", "▌", "▍", "▎", "▏"];
const SPIN_DISPATCH = ["◇", "◈", "◆", "◈"];
const DOTS_CYCLE = [".", "..", "...", "..", ".", ".."];
const DOTS_PADDED = DOTS_CYCLE.map((d) => d.padEnd(3));

const EXPLORE_PAIRS: [string, string][] = [
  ["Scanning the codebase…", "Scanned the codebase"],
  ["Reading the runes…", "Read the runes"],
  ["Tracing the threads…", "Traced the threads"],
  ["Mapping the terrain…", "Mapped the terrain"],
  ["Gathering intel…", "Gathered intel"],
  ["Following the trail…", "Followed the trail"],
  ["Consulting the index…", "Consulted the index"],
  ["Scouting ahead…", "Scouted ahead"],
  ["Connecting the dots…", "Connected the dots"],
  ["Parsing the signals…", "Parsed the signals"],
];

const EDIT_PAIRS: [string, string][] = [
  ["Forging changes…", "Forged changes"],
  ["Hammering code…", "Hammered code"],
  ["Shaping the metal…", "Shaped the metal"],
  ["Welding it together…", "Welded it together"],
  ["Carving the solution…", "Carved the solution"],
  ["Applying the fix…", "Applied the fix"],
  ["Rewriting reality…", "Rewrote reality"],
  ["Bending the code…", "Bent the code"],
  ["Crafting the patch…", "Crafted the patch"],
  ["Tempering the build…", "Tempered the build"],
];

const DISPATCH_PAIRS: [string, string][] = [
  ["Splitting into sparks…", "Sparks reunited"],
  ["Deploying the swarm…", "Swarm returned"],
  ["Lighting the embers…", "Embers cooled"],
  ["Rallying the anvils…", "Anvils reported back"],
  ["Spawning doppelgangers…", "Doppelgangers merged"],
  ["Dispatching agents…", "Agents returned"],
];

export interface FinalResponseTool {
  id: string;
  name: string;
  done: boolean;
  error: boolean;
  argStr: string;
  /** Optional sub-tree rendered as a tree continuation directly below this row (e.g. dispatch subagents). */
  subtree?: ReactNode;
  imageArt?: Array<{
    name: string;
    lines: string[];
    kittyImageId?: number;
    kittyCols?: number;
    kittyRows?: number;
  }>;
}

export function filterQuietTools(name: string): boolean {
  return !QUIET_TOOLS.has(name);
}

/** Rotating status message with glitch transition */
function useRotatingMessage(pairs: [string, string][], done: boolean) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * pairs.length));
  const [glitchTick, setGlitchTick] = useState(-1);
  const pairsRef = useRef(pairs);
  pairsRef.current = pairs;

  // Rotate on interval (streaming only)
  useEffect(() => {
    if (done) return;
    const timer = setInterval(() => {
      setGlitchTick(0);
    }, ROTATE_INTERVAL);
    return () => clearInterval(timer);
  }, [done]);

  // Glitch animation ticks
  useEffect(() => {
    if (glitchTick < 0) return;
    if (glitchTick >= GLITCH_FRAMES * 2) {
      setGlitchTick(-1);
      return;
    }
    // Advance to new message at the midpoint
    if (glitchTick === GLITCH_FRAMES) {
      setIndex((prev) => {
        let next = Math.floor(Math.random() * pairsRef.current.length);
        if (next === prev && pairsRef.current.length > 1)
          next = (prev + 1) % pairsRef.current.length;
        return next;
      });
    }
    const timer = setTimeout(() => setGlitchTick((t) => t + 1), GLITCH_TICK);
    return () => clearTimeout(timer);
  }, [glitchTick]);

  // When pairs array changes (phase shift), pick new index
  useEffect(() => {
    setIndex(Math.floor(Math.random() * pairs.length));
    setGlitchTick(0);
  }, [pairs]);

  const pair = pairs[index % pairs.length] as [string, string];
  const raw = done ? pair[1] : pair[0];
  // Strip trailing … — animated dots added separately by caller
  const text = glitchTick >= 0 ? garble(raw.replace(/…$/, "")) : raw.replace(/…$/, "");

  return text;
}

export const FinalResponseWrapper = memo(function FinalResponseWrapper({
  hasEdits,
  hasDispatch,
  done,
  seed: _seed,
  tools,
  children,
  loadingStartedAt = 0,
  toolExpanded,
  onToolClick,
  toolDetails,
  hideStatusHeader = false,
  pendingNarration = false,
}: {
  hasEdits: boolean;
  hasDispatch?: boolean;
  done: boolean;
  seed: number;
  tools: FinalResponseTool[];
  children?: ReactNode;
  loadingStartedAt?: number;
  toolExpanded?: Record<string, boolean>;
  onToolClick?: (toolId: string) => void;
  toolDetails?: (toolId: string) => ReactNode;
  hideStatusHeader?: boolean;
  /** Show a "Thinking…" trailing row when the agent is mid-narration with no active tool. */
  pendingNarration?: boolean;
}) {
  const t = useTheme();

  const effectiveDone = done;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (effectiveDone || !loadingStartedAt) return;
    const tick = () => setElapsed(Math.floor((Date.now() - loadingStartedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [effectiveDone, loadingStartedAt]);

  const pairs = hasDispatch ? DISPATCH_PAIRS : hasEdits ? EDIT_PAIRS : EXPLORE_PAIRS;
  const statusMsg = useRotatingMessage(pairs, effectiveDone);
  const statusColor = hasDispatch ? t.info : hasEdits ? t.warning : t.brand;
  const spinFrames = hasDispatch ? SPIN_DISPATCH : hasEdits ? SPIN_EDIT : SPIN_EXPLORE;

  const [showAllHidden, setShowAllHidden] = useState(false);
  const interactive = !!onToolClick;
  const naturalHiddenCount = Math.max(0, tools.length - MAX_VISIBLE);
  const hiddenCount = showAllHidden ? 0 : naturalHiddenCount;
  const hidden = tools.slice(0, naturalHiddenCount);
  const hiddenEdits = hidden.filter((tc) => FINAL_RESPONSE_EDIT_TOOLS.has(tc.name)).length;
  const visible = showAllHidden ? tools : tools.slice(-MAX_VISIBLE);

  return (
    <box flexDirection="column" marginTop={hideStatusHeader ? 0 : 1}>
      {hideStatusHeader ? null : (
        <box height={1} flexShrink={0}>
          <text truncate>
            {effectiveDone ? (
              <span fg={t.success}>{"✓ "}</span>
            ) : (
              <Spinner inline frames={spinFrames} color={statusColor} bold suffix={" "} />
            )}
            <span
              fg={effectiveDone ? t.textSecondary : t.textPrimary}
              attributes={effectiveDone ? undefined : TextAttributes.BOLD}
            >
              {statusMsg}
            </span>
            {effectiveDone ? null : (
              <Spinner inline frames={DOTS_PADDED} color={t.textMuted} divisor={4} />
            )}
            {!effectiveDone && elapsed > 0 ? (
              <span fg={t.textFaint}>{formatElapsed(elapsed)}</span>
            ) : null}
          </text>
        </box>
      )}

      {/* Tool rail */}
      {visible.length > 0 || children ? (
        <box
          flexDirection="column"
          border={["left"]}
          borderColor={effectiveDone ? t.textFaint : t.textMuted}
          paddingLeft={1}
          opacity={effectiveDone ? 0.6 : 1}
        >
          {hiddenCount > 0 ? (
            <HoverableRow onClick={() => setShowAllHidden(true)} interactive>
              <text truncate>
                <span fg={t.textDim}>
                  {icon("check")} +{String(hiddenCount)} completed
                  {hiddenEdits > 0 ? ` [${String(hiddenEdits)} edits]` : ""}
                  <span fg={t.textFaint}> (click to expand)</span>
                </span>
              </text>
            </HoverableRow>
          ) : showAllHidden && naturalHiddenCount > 0 ? (
            <HoverableRow onClick={() => setShowAllHidden(false)} interactive>
              <text truncate>
                <span fg={t.textFaint}>collapse +{String(naturalHiddenCount)} above</span>
              </text>
            </HoverableRow>
          ) : null}
          {visible.map((tc, i) => {
            const { icon: toolIcon, iconColor, label } = resolveToolDisplay(tc.name, t.textMuted);
            const doneLabel = TOOL_LABELS_DONE[tc.name] ?? label;
            const displayLabel = tc.done ? doneLabel : label;
            const isLast = i === visible.length - 1 && !children && !pendingNarration;
            const connector = isLast ? "└ " : i === 0 && hiddenCount === 0 ? "┌ " : "├ ";
            const statusClr = tc.done ? (tc.error ? t.error : t.success) : t.brand;
            const isExpanded = toolExpanded?.[tc.id] ?? tc.name === "soul_vision";

            return (
              <box key={tc.id} flexDirection="column" flexShrink={0}>
                <HoverableRow
                  interactive={interactive}
                  onClick={interactive ? () => onToolClick?.(tc.id) : undefined}
                >
                  <text truncate>
                    <span fg={t.textFaint}>{connector}</span>
                    {tc.done ? (
                      <span fg={statusClr}>{tc.error ? "✗" : "✓"}</span>
                    ) : (
                      <Spinner inline color={t.brand} />
                    )}
                    <span fg={tc.done ? t.textDim : iconColor}> {toolIcon} </span>
                    <span fg={tc.done ? t.textDim : t.brand}>{displayLabel}</span>
                    {tc.argStr ? (
                      <span fg={tc.done ? t.textDim : t.textSecondary}> {tc.argStr}</span>
                    ) : null}
                  </text>
                </HoverableRow>
                {tc.subtree ? (
                  <box
                    border={["left"]}
                    customBorderChars={isLast ? TREE_SPACE : TREE_PIPE}
                    borderColor={t.textFaint}
                    paddingLeft={1}
                    flexDirection="column"
                  >
                    {tc.subtree}
                  </box>
                ) : null}
                {interactive && isExpanded && toolDetails ? toolDetails(tc.id) : null}
                {tc.imageArt && tc.imageArt.length > 0 ? (
                  // opacity=1 — Kitty placeholders encode the image ID in the FG RGB triple
                  // (r,g,b = (id>>16, id>>8, id) & 0xff). The parent rail applies opacity 0.6
                  // when done, which blends the FG color and corrupts the encoded ID → Kitty
                  // can't bind the placement → blank rect. Force full opacity here.
                  <box
                    flexDirection="column"
                    paddingLeft={2}
                    marginTop={1}
                    marginBottom={1}
                    opacity={1}
                  >
                    {tc.imageArt.map((img) => (
                      <box key={img.name} flexDirection="column">
                        <ImageDisplay img={img} />
                      </box>
                    ))}
                  </box>
                ) : null}
              </box>
            );
          })}
          {pendingNarration ? (
            <box height={1} flexShrink={0}>
              <text truncate>
                <span fg={t.textFaint}>{children ? "├ " : "└ "}</span>
                <Spinner inline color={t.textMuted} />
                <span fg={t.textDim}> Thinking</span>
                <Spinner inline frames={DOTS_PADDED} color={t.textMuted} divisor={4} />
              </text>
            </box>
          ) : null}
          {children}
        </box>
      ) : null}
    </box>
  );
});

export const FinalResponseLiveAutoView = memo(function FinalResponseLiveAutoView({
  segments,
  liveToolCalls,
  loadingStartedAt,
  messagesLength,
  finalResponseCalled: _finalResponseCalled,
}: {
  segments: StreamSegment[];
  liveToolCalls: LiveToolCall[];
  loadingStartedAt: number;
  messagesLength: number;
  /** Retained for API compatibility; rendering is now segment-positional. */
  finalResponseCalled: boolean;
}) {
  // Stable timeline: walk segments once and emit each in place. Adjacent
  // `tools` segments collapse into a single rail so consecutive tool calls
  // share one frame. Text segments — wherever they appear — always render.
  // No derived "opening/trailing/chat-only" slots → no content ever flips
  // from visible to hidden when a new segment arrives.
  type Block =
    | { kind: "text"; key: string; content: string }
    | { kind: "reasoning"; key: string }
    | { kind: "rail"; key: string; toolCallIds: string[] };

  const toolCallMap = useMemo(() => {
    const m = new Map<string, LiveToolCall>();
    for (const tc of liveToolCalls) m.set(tc.id, tc);
    return m;
  }, [liveToolCalls]);

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) continue;
      if (seg.type === "text") {
        if (seg.content.length === 0) continue;
        out.push({ kind: "text", key: `t-${i}`, content: seg.content });
      } else if (seg.type === "reasoning") {
        out.push({ kind: "reasoning", key: `r-${seg.id}-${i}` });
      } else {
        const last = out[out.length - 1];
        if (last?.kind === "rail") {
          last.toolCallIds = [...last.toolCallIds, ...seg.callIds];
        } else {
          out.push({ kind: "rail", key: `rail-${i}`, toolCallIds: [...seg.callIds] });
        }
      }
    }
    return out;
  }, [segments]);

  const hasDispatch = useMemo(
    () => liveToolCalls.some((tc) => SUBAGENT_NAMES.has(tc.toolName)),
    [liveToolCalls],
  );

  const hasEdits = useMemo(
    () => liveToolCalls.some((tc) => FINAL_RESPONSE_EDIT_TOOLS.has(tc.toolName)),
    [liveToolCalls],
  );

  const dispatchActive = liveToolCalls.some(
    (tc) => SUBAGENT_NAMES.has(tc.toolName) && tc.state === "running",
  );

  const lastRailIdx = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]?.kind === "rail") return i;
    }
    return -1;
  }, [blocks]);

  const trailingTextAfterRail = useMemo(() => {
    if (lastRailIdx < 0) return false;
    for (let i = lastRailIdx + 1; i < blocks.length; i++) {
      if (blocks[i]?.kind === "text") return true;
    }
    return false;
  }, [blocks, lastRailIdx]);

  return (
    <box flexDirection="column">
      {blocks.map((block, idx) => {
        if (block.kind === "text") {
          const isFirst = idx === 0;
          return (
            <box key={block.key} flexDirection="column" marginTop={isFirst ? 0 : 1}>
              <DripText content={block.content} streaming />
            </box>
          );
        }
        if (block.kind === "reasoning") {
          return null;
        }
        const calls: LiveToolCall[] = [];
        for (const id of block.toolCallIds) {
          const tc = toolCallMap.get(id);
          if (tc && filterQuietTools(tc.toolName)) calls.push(tc);
        }
        if (calls.length === 0) return null;
        const tools: FinalResponseTool[] = calls.map((tc) => {
          const isDispatch = SUBAGENT_NAMES.has(tc.toolName);
          return {
            id: tc.id,
            name: tc.toolName,
            done: tc.state !== "running",
            error: tc.state === "error",
            argStr: formatArgs(tc.toolName, tc.args),
            subtree: isDispatch ? <DispatchSubtree call={tc} /> : undefined,
            imageArt: tc.imageArt,
          };
        });
        const allToolsDone = tools.length > 0 && tools.every((t) => t.done);
        const isLastRail = idx === lastRailIdx;
        const pendingNarration =
          isLastRail && allToolsDone && !dispatchActive && !trailingTextAfterRail;
        return (
          <box key={block.key} flexDirection="column">
            <FinalResponseWrapper
              hasEdits={hasEdits}
              hasDispatch={hasDispatch}
              done={false}
              seed={messagesLength}
              loadingStartedAt={loadingStartedAt}
              tools={tools}
              pendingNarration={pendingNarration}
            />
          </box>
        );
      })}
    </box>
  );
});
function HoverableRow({
  children,
  onClick,
  interactive,
}: {
  children: ReactNode;
  onClick?: () => void;
  interactive?: boolean;
}) {
  const t = useTheme();
  const [hovered, hoverHandlers] = useHover();
  if (!interactive) {
    return (
      <box height={1} flexShrink={0}>
        {children}
      </box>
    );
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: opentui box is the interactive primitive in TUI; a11y rule targets DOM
    <box
      height={1}
      flexShrink={0}
      backgroundColor={hovered ? t.bgElevated : undefined}
      onMouseDown={onClick}
      {...hoverHandlers}
    >
      {children}
    </box>
  );
}
