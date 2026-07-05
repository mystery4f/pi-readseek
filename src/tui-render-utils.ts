import { relative } from "node:path";
import { pathToFileURL } from "node:url";

import { getCapabilities, hyperlink, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { resolveToCwd } from "./path-utils.js";

export const SUMMARY_PREFIX = "↳";
export const EXPAND_HINT = " • Ctrl+O to expand";

export type RendererTheme = {
  fg(style: string, text: string): string;
  bold(text: string): string;
};

export function renderToolLabel(theme: RendererTheme, label: string): string {
  const boldFn = typeof theme.bold === "function" ? theme.bold.bind(theme) : (text: string) => text;
  return theme.fg("toolTitle", boldFn(label));
}

export function linkToolPath(styledText: string, rawPath: string, cwd: string): string {
  try {
    if (!getCapabilities().hyperlinks) return styledText;
    const absolutePath = resolveToCwd(rawPath, cwd);
    return hyperlink(styledText, pathToFileURL(absolutePath).href);
  } catch {
    return styledText;
  }
}

export function appendExpandHint(text: string, hidden: boolean): string {
  return hidden ? `${text}${EXPAND_HINT}` : text;
}

export function summaryLine(summary: string, options: { hidden?: boolean } = {}): string {
  return appendExpandHint(`${SUMMARY_PREFIX} ${summary}`, !!options.hidden);
}

export function isRendererExpanded(options?: { expanded?: boolean }, context?: { expanded?: boolean }): boolean {
  return context?.expanded ?? options?.expanded ?? false;
}

export interface RenderResultContext {
  isPartial: boolean;
  isError: boolean;
  expanded: boolean;
  width: number | undefined;
  cwd: string;
  context: Record<string, any>;
}

/**
 * Resolve the shared render context for a tool's `renderResult`, which may
 * receive its context either as a trailing `rest[0]` argument or folded into
 * `options`. Returns the common flags plus the raw context object for callers
 * that need fields beyond the common set (e.g. `lastComponent`).
 */
export function resolveRenderResultContext(options: any, rest: any[]): RenderResultContext {
  const context = rest[0] ?? options ?? {};
  return {
    isPartial: context.isPartial ?? options?.isPartial ?? false,
    isError: context.isError ?? false,
    expanded: isRendererExpanded(options, context),
    width: context.width ?? options?.width,
    cwd: context.cwd ?? process.cwd(),
    context,
  };
}

export function normalizeWidth(width: unknown, fallback = 80): number {
  return typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width) : fallback;
}

export function clampLineToWidth(line: string, width: number | undefined): string {
  if (width === undefined || width === null) return line;
  const normalized = normalizeWidth(width);
  return visibleWidth(line) <= normalized ? line : truncateToWidth(line, normalized);
}

export function clampLinesToWidth(lines: string[], width: number | undefined): string[] {
  if (width === undefined || width === null) return lines;
  return lines.map((line) => clampLineToWidth(line, width));
}

export interface WrapWithHangingIndentOptions {
  /** Optional transform applied to each produced line (e.g. theme tinting). */
  tint?: (text: string) => string;
}

/**
 * Wrap a single visual row that has a leading prefix (gutter, line number,
 * separator) such that continuation lines are indented to align with the
 * content column. Each produced line is clamped to `width`. If `tint` is
 * provided, it is applied to each output line so theme styling extends across
 * wrapped rows without leaking the prefix into the colored span.
 */
export function wrapWithHangingIndent(
  prefix: string,
  content: string,
  width: number | undefined,
  options: WrapWithHangingIndentOptions = {},
): string[] {
  const tint = options.tint ?? ((text: string) => text);
  if (width === undefined || width === null) return [tint(prefix + content)];
  const normalized = normalizeWidth(width);
  const combined = prefix + content;
  if (visibleWidth(combined) <= normalized) return [tint(combined)];
  const prefixWidth = visibleWidth(prefix);
  const contentWidth = Math.max(1, normalized - prefixWidth);
  const wrapped = wrapTextWithAnsi(content, contentWidth);
  if (wrapped.length === 0) return [tint(clampLineToWidth(prefix, normalized))];
  const indent = " ".repeat(prefixWidth);
  return wrapped.map((line, index) =>
    tint(clampLineToWidth(index === 0 ? prefix + line : indent + line, normalized)),
  );
}
const HASHLINE_CONTENT_RE = /^(\d+:[0-9a-fA-F]+\|)(.*)$/;

export function wrapReadHashlinesForWidth(text: string, width: number | undefined): string {
  if (width === undefined || width === null) return text;
  const normalized = normalizeWidth(width);
  const output: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(HASHLINE_CONTENT_RE);
    if (!match) {
      output.push(line);
      continue;
    }
    if (visibleWidth(line) <= normalized) {
      output.push(line);
      continue;
    }

    const prefix = match[1]!;
    const content = match[2] ?? "";
    const prefixWidth = visibleWidth(prefix);
    const contentWidth = Math.max(1, normalized - prefixWidth);
    const wrappedContent = wrapTextWithAnsi(content, contentWidth).map((wrapped) => clampLineToWidth(wrapped, contentWidth));
    if (wrappedContent.length === 0) {
      output.push(clampLineToWidth(prefix, normalized));
      continue;
    }
    output.push(clampLineToWidth(prefix + wrappedContent[0], normalized));
    const indent = " ".repeat(prefixWidth);
    for (const continuation of wrappedContent.slice(1)) {
      output.push(clampLineToWidth(indent + continuation, normalized));
    }
  }
  return output.join("\n");
}

const wrappedHashlinesCache = new WeakMap<object, { text: string; width: number | undefined; wrapped: string }>();

/**
 * Memoized {@link wrapReadHashlinesForWidth} for render paths that re-run on
 * every TUI frame: the wrapped output is cached per result content object so
 * an expanded read result is only re-wrapped when its text or the terminal
 * width changes.
 */
export function wrapReadHashlinesForWidthCached(
  cacheKey: object,
  text: string,
  width: number | undefined,
): string {
  const cached = wrappedHashlinesCache.get(cacheKey);
  if (cached && cached.text === text && cached.width === width) return cached.wrapped;
  const wrapped = wrapReadHashlinesForWidth(text, width);
  wrappedHashlinesCache.set(cacheKey, { text, width, wrapped });
  return wrapped;
}

/**
 * Render the `isPartial` placeholder line shared by every tool's `renderResult`.
 */
export function renderPendingResult(pendingLabel: string, width: number | undefined): Text {
  return new Text(clampLinesToWidth([summaryLine(pendingLabel)], width).join("\n"), 0, 0);
}

/**
 * Render a tool result error: the first line of `textContent`, or its full body
 * when expanded, prefixed and clamped to width. Tools pass their own `fallback`
 * for the empty-content case.
 */
export function renderErrorResult(
  textContent: string,
  options: { expanded: boolean; width: number | undefined; fallback?: string },
): Text {
  const firstLine = textContent.split("\n")[0] || (options.fallback ?? "Error");
  const body = options.expanded && textContent ? textContent : firstLine;
  return new Text(clampLinesToWidth(summaryLine(body).split("\n"), options.width).join("\n"), 0, 0);
}

export interface AnchoredFilesLabels {
  pendingLabel: string;
  emptyLabel: string;
  unitSingular: string;
  unitPlural: string;
}

/**
 * Render the call line shared by the readseek search tools (search, refs): a
 * tool label, an accent term, the search path, an optional language hint, and
 * the active boolean flags. Falsy {@link opts.flags} entries are dropped.
 */
export function renderReadSeekSearchCall(
  args: { path?: string; lang?: string },
  theme: RendererTheme,
  rest: any[],
  opts: { label: string; accent: string; flags: Array<string | false | undefined> },
): Text {
  const context = rest[0] ?? {};
  let text = `${renderToolLabel(theme, opts.label)} ${theme.fg("accent", opts.accent)}`;
  text += theme.fg("dim", ` in ${args.path ?? "."}`);
  if (args.lang) text += theme.fg("dim", ` (${args.lang})`);
  const flags = opts.flags.filter(Boolean);
  if (flags.length > 0) text += theme.fg("dim", ` [${flags.join(",")}]`);
  return new Text(clampLineToWidth(text, context.width), 0, 0);
}

/**
 * Render the result summary shared by the anchored-files search tools (search,
 * refs): a pending line, an error first-line/expanded body, an empty-result
 * line, or a `<count> <unit> in <n> files` summary with an expandable per-file
 * list. The four call-site differences are supplied via {@link labels}.
 */
export function renderAnchoredFilesResult(
  result: any,
  options: any,
  theme: RendererTheme,
  rest: any[],
  labels: AnchoredFilesLabels,
): Text {
  const { isPartial, isError, expanded, cwd, width } = resolveRenderResultContext(options, rest);

  if (isPartial) return renderPendingResult(labels.pendingLabel, width);

  const content = result.content?.[0];
  const textContent = content?.type === "text" ? content.text : "";
  if (isError || result.isError) return renderErrorResult(textContent, { expanded, width });

  const readseekValue = (result.details as any)?.readseekValue as
    | { files: Array<{ path: string; lines: any[] }> }
    | undefined;
  const files = readseekValue?.files ?? [];
  if (files.length === 0) return new Text(summaryLine(labels.emptyLabel), 0, 0);

  const fileCount = files.length;
  const total = files.reduce((sum: number, f: any) => sum + f.lines.length, 0);
  const unitWord = total === 1 ? labels.unitSingular : labels.unitPlural;
  const fileWord = fileCount === 1 ? "file" : "files";
  let text = summaryLine(`${total} ${unitWord} in ${fileCount} ${fileWord}`, { hidden: !expanded });
  if (expanded) {
    for (const file of files.slice(0, 20)) {
      const display = relative(cwd, file.path) || file.path;
      text += "\n" + theme.fg("dim", `  ${display} (${file.lines.length})`);
    }
    if (files.length > 20) text += "\n" + theme.fg("muted", `  … and ${files.length - 20} more files`);
  }
  return new Text(clampLinesToWidth(text.split("\n"), width).join("\n"), 0, 0);
}
