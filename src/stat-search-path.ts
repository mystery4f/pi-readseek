import { stat as fsStat } from "node:fs/promises";
import type { Stats } from "node:fs";

import { buildToolErrorResult, type ToolErrorResult } from "./readseek-value.js";

export type StatSearchPathResult =
  | { ok: true; stats: Stats }
  | { ok: false; error: ToolErrorResult };

/**
 * Stat a tool's search path, mapping access failures into the shared readseek
 * error taxonomy. Used by refs and search, which reject a missing or
 * unreadable path with identical codes and messages.
 */
export async function statSearchPathOrError(
  tool: string,
  rawPath: string | undefined,
  searchPath: string,
): Promise<StatSearchPathResult> {
  try {
    return { ok: true, stats: await fsStat(searchPath) };
  } catch (err: any) {
    const display = rawPath ?? ".";
    const path = rawPath ?? searchPath;
    if (err?.code === "ENOENT") {
      return { ok: false, error: buildToolErrorResult(tool, "path-not-found", `Error: path '${display}' does not exist`, { path }) };
    }
    if (err?.code === "EACCES" || err?.code === "EPERM") {
      return { ok: false, error: buildToolErrorResult(tool, "permission-denied", `Error: permission denied for path '${display}'`, { path }) };
    }
    const message = `Error: could not access path '${display}': ${err?.message ?? String(err)}`;
    return { ok: false, error: buildToolErrorResult(tool, "fs-error", message, { path, details: { fsCode: err?.code, fsMessage: err?.message } }) };
  }
}
