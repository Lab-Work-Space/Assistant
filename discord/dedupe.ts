/** Every guild message reaches all 9 clients; this lets it through once. LRU over message ids. */
export class Dedupe {
  private readonly ids = new Map<string, true>();

  constructor(private readonly max = 5000) {}

  /** True if `messageId` was already seen; otherwise records it and returns false. */
  seen(messageId: string): boolean {
    if (this.ids.has(messageId)) {
      this.ids.delete(messageId); // refresh recency
      this.ids.set(messageId, true);
      return true;
    }
    this.ids.set(messageId, true);
    if (this.ids.size > this.max) this.ids.delete(this.ids.keys().next().value as string);
    return false;
  }
}
