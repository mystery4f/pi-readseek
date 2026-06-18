/**
 * Callback used when a tool returns fresh anchors for a file path.
 */
export type FileAnchoredCallback = (absolutePath: string) => void;

/**
 * Predicate used by mutating tools to check whether a file has session-fresh anchors.
 */
export type FreshAnchorsPredicate = (absolutePath: string) => boolean;
