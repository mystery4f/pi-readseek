import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/read.js";
import { registerReadManyTool } from "./src/read-many.js";
import { registerEditTool } from "./src/edit.js";
import { registerGrepTool } from "./src/grep.js";
import { registerSgTool } from "./src/sg.js";
import { registerRefsTool } from "./src/refs.js";
import { registerRenameTool } from "./src/rename.js";
import { registerHoverTool } from "./src/hover.js";
import { registerWriteTool } from "./src/write.js";
import { registerDefTool } from "./src/def.js";
import { SessionAnchors } from "./src/session-anchors.js";
import { isReadSeekAvailable } from "./src/readseek-client.js";

export default function piReadSeekExtension(pi: ExtensionAPI): void {
	const sessionAnchors = new SessionAnchors();
	const markAnchored = (absolutePath: string) => sessionAnchors.markAnchored(absolutePath);
	const hasFreshAnchors = (absolutePath: string) => sessionAnchors.hasFreshAnchors(absolutePath);

	registerReadTool(pi, { onSuccessfulRead: markAnchored });
	registerReadManyTool(pi, { onSuccessfulRead: markAnchored });
	registerEditTool(pi, { wasReadInSession: hasFreshAnchors });
	const searchAvailable = isReadSeekAvailable();
	const searchGuideline = searchAvailable
		? "Use grep summary for counts; use search for structural code patterns."
		: "Use grep summary for counts; search is unavailable (readseek native backend not loaded).";

	registerGrepTool(pi, { searchGuideline, onFileAnchored: markAnchored });
	registerSgTool(pi, { onFileAnchored: markAnchored });
	registerRefsTool(pi, { onFileAnchored: markAnchored });
	registerRenameTool(pi);
	registerHoverTool(pi);
	registerDefTool(pi, { onFileAnchored: markAnchored });
	registerWriteTool(pi, { onFileAnchored: markAnchored });
}
