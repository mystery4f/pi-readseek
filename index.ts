import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/read.js";
import { registerEditTool } from "./src/edit.js";
import { registerGrepTool } from "./src/grep.js";
import { registerSgTool, isSgAvailable } from "./src/sg.js";
import { registerWriteTool } from "./src/write.js";
export default function piReadseekExtension(pi: ExtensionAPI): void {
	const readPaths = new Set<string>();
	const noteRead = (absolutePath: string) => {
		readPaths.add(absolutePath);
	};
	const wasReadInSession = (absolutePath: string) => readPaths.has(absolutePath);

	registerReadTool(pi, { onSuccessfulRead: noteRead });
	registerEditTool(pi, { wasReadInSession });
	const sgAvailable = isSgAvailable();
	const searchGuideline = sgAvailable
		? "Use grep summary for counts; use search for structural code patterns."
		: "Use grep summary for counts; install @jarkkojs/readseek to enable search.";

	registerGrepTool(pi, { searchGuideline, onFileAnchored: noteRead });
	registerSgTool(pi, { onFileAnchored: noteRead });
	registerWriteTool(pi, { onFileAnchored: noteRead });
}
