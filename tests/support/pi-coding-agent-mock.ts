interface TruncationResult {
	content: string;
	outputBytes: number;
	outputLines: number;
	totalBytes: number;
	totalLines: number;
	truncated: boolean;
}

function countLines(content: string): number {
	return content.length === 0 ? 0 : content.split("\n").length;
}

/**
 * Creates safe pi-coding-agent exports for tests that must not load the real module.
 */
export function createPiCodingAgentBaseMock() {
	return {
		DEFAULT_MAX_BYTES: 1024 * 1024,
		DEFAULT_MAX_LINES: 10000,
		formatSize: (bytes: number) => `${bytes}B`,
		truncateHead: (content: string): TruncationResult => {
			const bytes = Buffer.byteLength(content, "utf8");
			const lines = countLines(content);

			return {
				content,
				outputBytes: bytes,
				outputLines: lines,
				totalBytes: bytes,
				totalLines: lines,
				truncated: false,
			};
		},
	};
}
