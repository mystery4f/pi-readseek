import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ReadSeekJsonSettings {
  grep?: { maxLines?: number; maxBytes?: number };
  edit?: { diffDisplay?: "collapsed" | "expanded" };
}

interface ReadSeekSettingsWarning {
  source: string;
  message: string;
  path?: string;
}

interface ReadSeekSettingsResult {
  settings: ReadSeekJsonSettings;
  warnings: ReadSeekSettingsWarning[];
}


function defaultGlobalSettingsPath(): string {
  return join(homedir(), ".pi/agent/readseek/settings.json");
}

function defaultProjectSettingsPath(): string {
  return join(process.cwd(), ".pi/readseek/settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(source: string, path: string): ReadSeekSettingsWarning {
  return { source, path, message: `Invalid readseek setting at ${path}` };
}

function readPositive(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  source: string,
  warnings: ReadSeekSettingsWarning[],
): number | undefined {
  if (!(key in raw)) return undefined;
  const val = raw[key];
  if (typeof val === "number" && Number.isSafeInteger(val) && val > 0) return val;
  warnings.push(invalid(source, path));
  return undefined;
}


function validateSettings(raw: unknown, source: string): ReadSeekSettingsResult {
  const settings: ReadSeekJsonSettings = {};
  const warnings: ReadSeekSettingsWarning[] = [];
  if (!isRecord(raw)) return { settings, warnings };

  if (isRecord(raw.grep)) {
    const grep: NonNullable<ReadSeekJsonSettings["grep"]> = {};
    const maxLines = readPositive(raw.grep, "maxLines", "grep.maxLines", source, warnings);
    if (maxLines !== undefined) grep.maxLines = maxLines;
    const maxBytes = readPositive(raw.grep, "maxBytes", "grep.maxBytes", source, warnings);
    if (maxBytes !== undefined) grep.maxBytes = maxBytes;
    if (Object.keys(grep).length > 0) settings.grep = grep;
  }


  if (isRecord(raw.edit)) {
    const edit: NonNullable<ReadSeekJsonSettings["edit"]> = {};
    if ("diffDisplay" in raw.edit) {
      const value = raw.edit.diffDisplay;
      if (value === "collapsed" || value === "expanded") edit.diffDisplay = value;
      else warnings.push(invalid(source, "edit.diffDisplay"));
    }
    if (Object.keys(edit).length > 0) settings.edit = edit;
  }

  return { settings, warnings };
}

function readSettingsFile(path: string): ReadSeekSettingsResult {
  if (!existsSync(path)) return { settings: {}, warnings: [] };

  try {
    const text = readFileSync(path, "utf8");
    return validateSettings(JSON.parse(text) as unknown, path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { settings: {}, warnings: [{ source: path, message: `Invalid JSON: ${message}` }] };
  }
}

function mergeSettings(base: ReadSeekJsonSettings, override: ReadSeekJsonSettings): ReadSeekJsonSettings {
  const merged: ReadSeekJsonSettings = {};
  const grep = { ...(base.grep ?? {}), ...(override.grep ?? {}) };
  if (Object.keys(grep).length > 0) merged.grep = grep;
  const edit = { ...(base.edit ?? {}), ...(override.edit ?? {}) };
  if (Object.keys(edit).length > 0) merged.edit = edit;
  return merged;
}

export function resolveReadSeekJsonSettings(): ReadSeekSettingsResult {
  const globalResult = readSettingsFile(defaultGlobalSettingsPath());
  const projectResult = readSettingsFile(defaultProjectSettingsPath());
  return {
    settings: mergeSettings(globalResult.settings, projectResult.settings),
    warnings: [...globalResult.warnings, ...projectResult.warnings],
  };
}

export function resolveEditDiffDisplay(env: NodeJS.ProcessEnv = process.env): "collapsed" | "expanded" {
  const raw = env.READSEEK_EDIT_DIFF_DISPLAY;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "expanded" || normalized === "collapsed") return normalized;
  }
  const json = resolveReadSeekJsonSettings().settings.edit?.diffDisplay;
  if (json === "expanded" || json === "collapsed") return json;
  return "collapsed";
}
