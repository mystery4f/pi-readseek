import type { ExtensionAPI, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import { stat as fsStat } from "node:fs/promises";
import { defineToolPromptMetadata } from "./tool-prompt-metadata.js";
import { buildReadseekLineWithHash, buildToolErrorResult } from "./readseek-value.js";
import { resolveToCwd } from "./path-utils.js";
import { classifyReadseekFailure, readseekRefs, type ReadseekReference } from "./readseek-client.js";
import { buildRefsOutput, type RefsOutputFile, type RefsOutputLine } from "./refs-output.js";
import type { FileAnchoredCallback } from "./tool-types.js";
import { registerReadseekTool } from "./register-tool.js";

import { clampLineToWidth, renderAnchoredFilesResult, renderToolLabel } from "./tui-render-utils.js";

type RefsParams = {
  name: string;
  path?: string;
  lang?: string;
  scope?: boolean;
  line?: number;
  column?: number;
  cached?: boolean;
  others?: boolean;
  ignored?: boolean;
};

const REFS_PROMPT_METADATA = defineToolPromptMetadata({
  promptUrl: new URL("../prompts/refs.md", import.meta.url),
  promptSnippet: "Find references to an identifier with readseek and return edit-ready anchors",
});

interface RefsToolOptions {
  onFileAnchored?: FileAnchoredCallback;
}

/**
 * Inputs for executing the references tool without registering it.
 */
export interface ExecuteRefsOptions {
  params: unknown;
  signal: AbortSignal | undefined;
  cwd: string;
  onFileAnchored?: FileAnchoredCallback;
}

function refsLine(reference: ReadseekReference): RefsOutputLine {
  return {
    ...buildReadseekLineWithHash(reference.line, reference.line_hash, reference.text),
    enclosingSymbol: reference.enclosingSymbol,
  };
}

function groupReferences(references: ReadseekReference[], cwd: string): RefsOutputFile[] {
  const files = new Map<string, RefsOutputFile>();
  const seen = new Set<string>();
  for (const reference of references) {
    const abs = path.isAbsolute(reference.file) ? reference.file : path.resolve(cwd, reference.file);
    const dedupeKey = `${abs}:${reference.line}:${reference.column}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    let file = files.get(abs);
    if (!file) {
      file = { displayPath: path.relative(cwd, abs) || abs, path: abs, lines: [] };
      files.set(abs, file);
    }
    file.lines.push(refsLine(reference));
  }
  return [...files.values()];
}

function isReadseekCursorValidationFailure(message: string): boolean {
  return (
    /line and column must be greater than zero/i.test(message) ||
    /line \d+ not found/i.test(message) ||
    /column \d+ exceeds maximum column \d+ for line \d+/i.test(message)
  );
}

/**
 * Executes identifier reference lookup and returns readseek-anchored matches.
 */
export async function executeRefs(opts: ExecuteRefsOptions): Promise<any> {
  const { params, signal, cwd, onFileAnchored } = opts;
  const p = params as RefsParams;
  if (p.ignored && !p.others) {
    return buildToolErrorResult("refs", "invalid-parameter", "Error: refs parameter 'ignored' requires 'others'");
  }
  if (p.scope && p.line === undefined) {
    return buildToolErrorResult("refs", "invalid-parameter", "Error: refs parameter 'scope' requires 'line'");
  }
  const searchPath = resolveToCwd(p.path ?? ".", cwd);

  try {
    await fsStat(searchPath);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return buildToolErrorResult("refs", "path-not-found", `Error: path '${p.path ?? "."}' does not exist`, {
        path: p.path ?? searchPath,
      });
    }
    if (err?.code === "EACCES" || err?.code === "EPERM") {
      return buildToolErrorResult("refs", "permission-denied", `Error: permission denied for path '${p.path ?? "."}'`, {
        path: p.path ?? searchPath,
      });
    }
    const message = `Error: could not access path '${p.path ?? "."}': ${err?.message ?? String(err)}`;
    return buildToolErrorResult("refs", "fs-error", message, {
      path: p.path ?? searchPath,
      details: { fsCode: err?.code, fsMessage: err?.message },
    });
  }

  try {
    const references = await readseekRefs(searchPath, p.name, {
      scope: p.scope,
      line: p.line,
      column: p.column,
      language: p.lang,
      cached: p.cached,
      others: p.others,
      ignored: p.ignored,
      signal,
    });
    const files = groupReferences(references, cwd);
    const builtOutput = buildRefsOutput({ name: p.name, files });
    for (const file of files) {
      onFileAnchored?.(file.path);
    }
    return {
      content: [{ type: "text", text: builtOutput.text }],
      details: { readseekValue: builtOutput.readseekValue },
    };
  } catch (err: any) {
    const failure = classifyReadseekFailure(err);
    if (p.scope && isReadseekCursorValidationFailure(failure.message)) {
      return buildToolErrorResult("refs", "invalid-parameter", failure.message);
    }
    return buildToolErrorResult("refs", failure.code, failure.message, failure.hint ? { hint: failure.hint } : {});
  }
}

export function registerRefsTool(pi: ExtensionAPI, options: RefsToolOptions = {}) {
  const tool = registerReadseekTool(pi, {
    policy: "read-only",
    pythonName: "refs",
    defaultExposure: "opt-in",
  }, {
    name: "refs",
    label: "References",
    description: REFS_PROMPT_METADATA.description,
    promptSnippet: REFS_PROMPT_METADATA.promptSnippet,
    promptGuidelines: REFS_PROMPT_METADATA.promptGuidelines,
    parameters: Type.Object({
      name: Type.String({ description: "Identifier to find references for" }),
      path: Type.Optional(Type.String({ description: "Search path" })),
      lang: Type.Optional(Type.String({ description: "Language hint" })),
      scope: Type.Optional(Type.Boolean({ description: "Restrict to the binding under line/column (single file)" })),
      line: Type.Optional(Type.Number({ description: "One-based cursor line, used with scope" })),
      column: Type.Optional(Type.Number({ description: "One-based cursor byte column, used with scope" })),
      cached: Type.Optional(Type.Boolean({ description: "In a Git repository, search tracked/indexed files" })),
      others: Type.Optional(Type.Boolean({ description: "In a Git repository, search untracked files" })),
      ignored: Type.Optional(Type.Boolean({ description: "With others=true, include ignored untracked files" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeRefs({ params, signal, cwd: ctx.cwd, onFileAnchored: options.onFileAnchored });
    },
    renderCall(args: any, theme: any, ...rest: any[]) {
      const context = rest[0] ?? {};
      let text = `${renderToolLabel(theme, "refs")} ${theme.fg("accent", args.name)}`;
      text += theme.fg("dim", ` in ${args.path ?? "."}`);
      if (args.lang) text += theme.fg("dim", ` (${args.lang})`);
      const flags = [args.scope && "scope", args.cached && "cached", args.others && "others", args.ignored && "ignored"].filter(Boolean);
      if (flags.length > 0) text += theme.fg("dim", ` [${flags.join(",")}]`);
      return new Text(clampLineToWidth(text, context.width), 0, 0);
    },
    renderResult(result: any, options: ToolRenderResultOptions, theme: any, ...rest: any[]) {
      return renderAnchoredFilesResult(result, options, theme, rest, {
        pendingLabel: "pending refs",
        emptyLabel: "no references",
        unitSingular: "reference",
        unitPlural: "references",
      });
    },
  });
  return tool;
}
