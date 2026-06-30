import type { ExtensionAPI, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import path from "node:path";

import { defineToolPromptMetadata } from "./tool-prompt-metadata.js";
import { buildReadSeekLineWithHash, buildToolErrorResult } from "./readseek-value.js";
import { resolveToCwd } from "./path-utils.js";
import { statSearchPathOrError } from "./stat-search-path.js";
import { classifyReadSeekFailure, readseekDef } from "./readseek-client.js";
import { searchPathParam, langParam, readseekGitSearchParams } from "./readseek-params.js";
import { registerReadSeekTool } from "./register-tool.js";

import { renderAnchoredFilesResult, renderReadSeekSearchCall } from "./tui-render-utils.js";
import type { FileAnchoredCallback } from "./tool-types.js";

const DEF_PROMPT_METADATA = defineToolPromptMetadata({
	promptUrl: new URL("../prompts/def.md", import.meta.url),
	promptSnippet: "Find structural symbol definitions with readseek",
});

type DefParams = {
	name?: string;
	path?: string;
	lang?: string;
	fromIdentify?: boolean;
	cached?: boolean;
	others?: boolean;
	ignored?: boolean;
};

interface DefToolOptions {
	onFileAnchored?: FileAnchoredCallback;
}

export interface ExecuteDefOptions {
	params: unknown;
	signal: AbortSignal | undefined;
	cwd: string;
	onFileAnchored?: FileAnchoredCallback;
}

export async function executeDef(opts: ExecuteDefOptions): Promise<any> {
	const { params, signal, cwd, onFileAnchored } = opts;
	const p = params as DefParams;

	if (!p.fromIdentify && (!p.name || !p.name.trim())) {
		return buildToolErrorResult("def", "invalid-parameter", "def requires 'name' or 'fromIdentify'");
	}

	const searchPath = resolveToCwd(p.path ?? ".", cwd);

	const statResult = await statSearchPathOrError("def", p.path, searchPath);
	if (!statResult.ok) return statResult.error;

	try {
		const definitions = await readseekDef(searchPath, {
			name: p.name,
			fromIdentify: p.fromIdentify,
			language: p.lang,
			cached: p.cached,
			others: p.others,
			ignored: p.ignored,
			signal,
		});

		if (definitions.length === 0) {
			return {
				content: [{ type: "text", text: "no definitions found" }],
				details: {
					readseekValue: { tool: "def", ok: true, path: searchPath, definitions: [] },
				},
			};
		}

		const files = new Map<string, { displayPath: string; path: string; lines: ReturnType<typeof buildReadSeekLineWithHash>[] }>();
		for (const def of definitions) {
			const abs = path.isAbsolute(def.file) ? def.file : path.resolve(cwd, def.file);
			let file = files.get(abs);
			if (!file) {
				file = { displayPath: path.relative(cwd, abs) || abs, path: abs, lines: [] };
				files.set(abs, file);
			}
			file.lines.push(buildReadSeekLineWithHash(def.line, def.line_hash, def.text));
		}

		const fileList = [...files.values()];
		for (const file of fileList) {
			onFileAnchored?.(file.path);
		}

		const textParts: string[] = [];
		for (const file of fileList) {
			textParts.push(file.displayPath);
			for (const line of file.lines) {
			textParts.push(`  ${line.line}:${line.hash} ${line.display}`);
			}
		}

		return {
			content: [{ type: "text", text: textParts.join("\n") }],
			details: {
				readseekValue: { tool: "def", ok: true, path: searchPath, definitions },
			},
		};
	} catch (err: any) {
		const failure = classifyReadSeekFailure(err);
		return buildToolErrorResult("def", failure.code, failure.message, failure.hint ? { hint: failure.hint } : {});
	}
}

export function registerDefTool(pi: ExtensionAPI, options: DefToolOptions = {}) {
	registerReadSeekTool(pi, {
		policy: "read-only",
		pythonName: "def",
		defaultExposure: "opt-in",
	}, {
		name: "def",
		label: "Definition",
		description: DEF_PROMPT_METADATA.description,
		promptSnippet: DEF_PROMPT_METADATA.promptSnippet,
		promptGuidelines: DEF_PROMPT_METADATA.promptGuidelines,
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Qualified or unqualified symbol name" })),
			path: searchPathParam(),
			lang: langParam(),
			fromIdentify: Type.Optional(Type.Boolean({ description: "Read identify output from stdin to choose the symbol name" })),
			...readseekGitSearchParams(),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeDef({ params, signal, cwd: ctx.cwd, onFileAnchored: options.onFileAnchored });
		},
		renderCall(args: any, theme: any, ...rest: any[]) {
			return renderReadSeekSearchCall(args, theme, rest, {
				label: "def",
				accent: args.name,
				flags: [args.fromIdentify && "from-identify", args.cached && "cached", args.others && "others", args.ignored && "ignored"],
			});
		},
		renderResult(result: any, options: ToolRenderResultOptions, theme: any, ...rest: any[]) {
			return renderAnchoredFilesResult(result, options, theme, rest, {
				pendingLabel: "pending def",
				emptyLabel: "no definitions",
				unitSingular: "definition",
				unitPlural: "definitions",
			});
		},
	});
}
