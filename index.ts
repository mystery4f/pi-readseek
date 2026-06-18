import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/read.js";
import { registerEditTool } from "./src/edit.js";
import { registerGrepTool } from "./src/grep.js";
import { registerSgTool, isSgAvailable } from "./src/sg.js";
import { registerRefsTool } from "./src/refs.js";
import { registerWriteTool } from "./src/write.js";
import { SessionAnchors } from "./src/session-anchors.js";

export default function piReadseekExtension(pi: ExtensionAPI): void {
	const sessionAnchors = new SessionAnchors();
	const markAnchored = (absolutePath: string) => sessionAnchors.markAnchored(absolutePath);
	const hasFreshAnchors = (absolutePath: string) => sessionAnchors.hasFreshAnchors(absolutePath);

	registerReadTool(pi, { onSuccessfulRead: markAnchored });
	registerEditTool(pi, { wasReadInSession: hasFreshAnchors });
	const sgAvailable = isSgAvailable();
	const searchGuideline = sgAvailable
		? "Use grep summary for counts; use search for structural code patterns."
		: "Use grep summary for counts; install @jarkkojs/readseek to enable search.";

	registerGrepTool(pi, { searchGuideline, onFileAnchored: markAnchored });
	registerSgTool(pi, { onFileAnchored: markAnchored });
	registerRefsTool(pi, { onFileAnchored: markAnchored });
	registerWriteTool(pi, { onFileAnchored: markAnchored });
}
