import { readFile } from "node:fs/promises";

import type { ExtensionAPI, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";

import { defineToolPromptMetadata } from "./tool-prompt-metadata.js";
import { buildToolErrorResult } from "./readseek-value.js";
import { resolveToCwd } from "./path-utils.js";
import { classifyReadSeekFailure, readseekIdentify } from "./readseek-client.js";
import { filePathParam, registerReadSeekTool } from "./register-tool.js";

import { clampLinesToWidth, linkToolPath, renderPendingResult, resolveRenderResultContext, summaryLine } from "./tui-render-utils.js";

const HOVER_PROMPT_METADATA = defineToolPromptMetadata({
	promptUrl: new URL("../prompts/hover.md", import.meta.url),
	promptSnippet: "Identify the identifier and enclosing symbol at a cursor position",
});

const hoverSchema = Type.Object({
	path: filePathParam(),
	line: Type.Number({ description: "One-based cursor line" }),
	column: Type.Optional(Type.Number({ description: "One-based cursor byte column" })),
});

interface HoverParams {
	path: string;
	line: number;
	column?: number;
}

export interface ExecuteHoverOptions {
	params: unknown;
	signal: AbortSignal | undefined;
	cwd: string;
}

export async function executeHover(opts: ExecuteHoverOptions): Promise<any> {
	const { params, signal, cwd } = opts;
	const p = params as HoverParams;

	if (!Number.isSafeInteger(p.line) || p.line < 1) {
		return buildToolErrorResult("hover", "invalid-parameter", "hover parameter 'line' must be a positive integer");
	}

	const filePath = resolveToCwd(p.path, cwd);

	let content: string;
	try {
		content = await readFile(filePath, "utf-8");
	} catch {
		return buildToolErrorResult("hover", "file-not-found", `hover could not read ${p.path}`);
	}

	try {
		const output = await readseekIdentify(filePath, content, {
			line: p.line,
			column: p.column,
			signal,
		});

		const lines: string[] = [];
		if (output.identifier) {
			lines.push(`identifier: ${output.identifier.text}`);
		}
		if (output.symbol) {
			lines.push(`symbol: ${output.symbol.name}`);
			lines.push(`kind: ${output.symbol.kind}`);
			lines.push(`qualified: ${output.symbol.qualified_name}`);
		}
		lines.push(`file: ${output.file}`);
		lines.push(`language: ${output.language}`);
		lines.push(`location: ${output.line}:${output.column}`);

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				readseekValue: {
					tool: "hover",
					ok: true,
					path: filePath,
					output,
				},
			},
		};
	} catch (err: any) {
		const failure = classifyReadSeekFailure(err);
		return buildToolErrorResult("hover", failure.code, failure.message, failure.hint ? { hint: failure.hint } : {});
	}
}

export function registerHoverTool(pi: ExtensionAPI) {
	registerReadSeekTool(pi, {
		policy: "read-only",
		pythonName: "hover",
		defaultExposure: "opt-in",
	}, {
		name: "hover",
		label: "Hover",
		description: HOVER_PROMPT_METADATA.description,
		promptSnippet: HOVER_PROMPT_METADATA.promptSnippet,
		promptGuidelines: HOVER_PROMPT_METADATA.promptGuidelines,
		parameters: hoverSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeHover({ params, signal, cwd: ctx.cwd });
		},
		renderCall(args: any, theme: any, ...rest: any[]) {
			const context = rest[0] ?? {};
			const cwd = context.cwd ?? process.cwd();
			const displayPath = typeof args?.path === "string" ? args.path : "?";
			let text = theme.fg("toolTitle", theme.bold("hover"));
			text += ` ${linkToolPath(theme.fg("accent", displayPath), displayPath, cwd)}`;
			if (args?.line) text += theme.fg("dim", `:${args.line}`);
			return text;
		},
		renderResult(result: any, options: ToolRenderResultOptions, theme: any, ...rest: any[]) {
			const { isPartial, isError, width } = resolveRenderResultContext(options, rest);

			if (isPartial) return renderPendingResult("pending hover", width);

			const content = result.content?.[0];
			const textContent = content?.type === "text" ? content.text : "";

			if (isError || result.isError) {
			return new Text(textContent || "hover failed", 0, 0);
			}

		return new Text(textContent.split("\n")[0] || "", 0, 0);
		},
	});
}
