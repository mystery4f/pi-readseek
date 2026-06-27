import type { Component } from "@earendil-works/pi-tui";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import type { DiffData } from "./diff-data.js";
import { renderTuiDiff } from "./tui-diff-renderer.js";
import { clampLineToWidth, normalizeWidth, type RendererTheme } from "./tui-render-utils.js";

export interface DiffPreviewComponentOptions {
	/**
	 * Lines rendered before the diff body (e.g. tool summary, "pending edit"
	 * header). Each entry is one logical line; the component is responsible
	 * for clamping to the render-time width.
	 */
	prefixLines?: string[];
	/**
	 * Lines rendered after the diff body (e.g. trailing hints). Currently
	 * unused but kept for symmetry.
	 */
	suffixLines?: string[];
	/** Diff body data. */
	diffData: DiffData;
	/** Theme passed through to renderTuiDiff for color tinting. */
	theme: RendererTheme;
	/** Whether the diff body should render in expanded form. */
	expanded: boolean;
	/**
	 * Optional fallback width used when render() receives an invalid width
	 * (zero, negative, NaN). Defaults to 80.
	 */
	fallbackWidth?: number;
}

/**
 * Self-rendering component for a tool's diff preview that defers wrapping
 * decisions to the TUI render pass.
 *
 * `renderTuiDiff` (and the underlying `wrapWithHangingIndent` helper) need
 * the real viewport width to choose between split / unified / compact / summary
 * modes and to wrap long content rows with prefix-aligned continuation lines.
 * Pi's `ToolRenderContext` does NOT carry the render-time width, so any
 * pre-baked output is forced to assume a fallback (80 columns). This
 * component holds the source data instead, then renders at the width pi's TUI
 * actually passes in.
 */
export class DiffPreviewComponent implements Component {
	private options: DiffPreviewComponentOptions;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(options: DiffPreviewComponentOptions) {
		this.options = options;
	}

	update(options: DiffPreviewComponentOptions): void {
		this.options = options;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const normalized = normalizeWidth(width, this.options.fallbackWidth ?? 80);
		if (this.cachedLines && this.cachedWidth === normalized) return this.cachedLines;
		const lines: string[] = [];
		for (const prefix of this.options.prefixLines ?? []) {
			for (const line of prefix.split("\n")) lines.push(clampLineToWidth(line, normalized));
		}
		const body = renderTuiDiff({
			diffData: this.options.diffData,
			width: normalized,
			theme: this.options.theme,
			expanded: this.options.expanded,
		});
		for (const line of body.lines) lines.push(line);
		for (const suffix of this.options.suffixLines ?? []) {
			for (const line of suffix.split("\n")) lines.push(clampLineToWidth(line, normalized));
		}
		// Final safety clamp: each rendered line must fit within the viewport.
		const clamped = lines.map((line) => (visibleWidth(line) <= normalized ? line : clampLineToWidth(line, normalized)));
		this.cachedLines = clamped;
		this.cachedWidth = normalized;
		return clamped;
	}
}

/**
 * Reuse the prior render tick's {@link DiffPreviewComponent} when present, else
 * construct one, then apply {@link options}. Keeps a streaming diff preview
 * stable across ticks instead of remounting a fresh component each frame.
 */
export function upsertDiffComponent(lastComponent: unknown, options: DiffPreviewComponentOptions): DiffPreviewComponent {
	const component = lastComponent instanceof DiffPreviewComponent ? lastComponent : new DiffPreviewComponent(options);
	component.update(options);
	return component;
}

/**
 * Reuse the prior render tick's text component when it is not a
 * {@link DiffPreviewComponent}, else construct a fresh {@link Text}, then set
 * its content to {@link text}.
 */
export function upsertTextComponent(lastComponent: any, text: string): Text {
	const component = lastComponent && !(lastComponent instanceof DiffPreviewComponent) ? lastComponent : new Text("", 0, 0);
	component.setText(text);
	return component;
}
