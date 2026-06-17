import { readseekCheck, type ReadseekCheckOutput, type ReadseekDiagnostic } from "./readseek-client.js";

export interface ValidateInput {
  filePath: string;
  before: string | undefined;
  after: string;
}

export interface ValidateResult {
  errorLines: string[];
  newErrorCount: number;
  newMissingCount: number;
}

function dedupeSortLines(diagnostics: ReadseekDiagnostic[]): string[] {
  const seen = new Set<string>();
  const out: Array<{ key: string; start: number }> = [];
  for (const diagnostic of diagnostics) {
    const key =
      diagnostic.start_line === diagnostic.end_line
        ? String(diagnostic.start_line)
        : `${diagnostic.start_line}-${diagnostic.end_line}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ key, start: diagnostic.start_line });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out.map((o) => o.key);
}

const EMPTY: ReadseekCheckOutput = { errorCount: 0, missingCount: 0, diagnostics: [] };

/**
 * Compare parse diagnostics between `before` and `after` and report any newly
 * introduced syntax errors. Uses readseek's native `check`, so every language
 * with a tree-sitter parser is validated.
 *
 * Returns `null` when nothing new appears or when readseek cannot parse the
 * file, so a validator failure never blocks an edit.
 */
export async function validateSyntaxRegression(
  input: ValidateInput,
): Promise<ValidateResult | null> {
  let before: ReadseekCheckOutput;
  let after: ReadseekCheckOutput;
  try {
    before = input.before === undefined ? EMPTY : await readseekCheck(input.filePath, input.before);
    after = await readseekCheck(input.filePath, input.after);
  } catch {
    return null;
  }

  const newErrorCount = Math.max(0, after.errorCount - before.errorCount - 1);
  const newMissingCount = Math.max(0, after.missingCount - before.missingCount);

  if (newErrorCount === 0 && newMissingCount === 0) return null;

  return {
    errorLines: dedupeSortLines(after.diagnostics),
    newErrorCount,
    newMissingCount,
  };
}
