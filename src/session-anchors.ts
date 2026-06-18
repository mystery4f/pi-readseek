/**
 * Tracks files that have fresh hashline anchors in the current extension session.
 */
export class SessionAnchors {
  readonly #paths = new Set<string>();

  /**
   * Records that a file has produced anchors usable by later edit calls.
   */
  markAnchored(absolutePath: string): void {
    this.#paths.add(absolutePath);
  }

  /**
   * Returns whether a file has fresh anchors in the current session.
   */
  hasFreshAnchors(absolutePath: string): boolean {
    return this.#paths.has(absolutePath);
  }
}
