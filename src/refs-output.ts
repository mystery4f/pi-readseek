import type { ReadSeekLine } from "./readseek-value.js";

export interface RefsOutputLine extends ReadSeekLine {
  enclosingSymbol?: string;
}

export interface RefsOutputFile {
  displayPath: string;
  path: string;
  lines: RefsOutputLine[];
}

interface BuildRefsOutputInput {
  name: string;
  files: RefsOutputFile[];
}

interface RefsOutputResult {
  text: string;
  readseekValue: {
    tool: "refs";
    files: Array<{
      path: string;
      lines: RefsOutputLine[];
    }>;
  };
}

export function buildRefsOutput(input: BuildRefsOutputInput): RefsOutputResult {
  if (input.files.length === 0) {
    return {
      text: `No references found for: ${input.name}`,
      readseekValue: { tool: "refs", files: [] },
    };
  }

  const blocks: string[] = [];
  for (const file of input.files) {
    blocks.push(`--- ${file.displayPath} ---`);
    for (const line of file.lines) {
      const suffix = line.enclosingSymbol ? ` (in ${line.enclosingSymbol})` : "";
      blocks.push(`>>${line.anchor}|${line.display}${suffix}`);
    }
  }

  return {
    text: blocks.join("\n"),
    readseekValue: {
      tool: "refs",
      files: input.files.map((file) => ({
        path: file.path,
        lines: file.lines.map((line) => ({ ...line })),
      })),
    },
  };
}
