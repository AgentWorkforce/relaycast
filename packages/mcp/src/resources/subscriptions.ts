/**
 * Manages resource subscription state.
 * Tracks which relay:// URIs the client has subscribed to.
 */
export class SubscriptionManager {
  private subscriptions = new Set<string>();

  subscribe(uri: string): void {
    this.subscriptions.add(uri);
  }

  unsubscribe(uri: string): void {
    this.subscriptions.delete(uri);
  }

  isSubscribed(uri: string): boolean {
    return this.subscriptions.has(uri);
  }

  /**
   * Returns all subscribed URIs that match the given list.
   * Used by the ws-bridge to find which subscriptions to notify.
   */
  getMatchingSubscriptions(uris: string[]): string[] {
    return uris.filter((uri) => this.subscriptions.has(uri));
  }

  getAll(): string[] {
    return [...this.subscriptions];
  }

  clear(): void {
    this.subscriptions.clear();
  }
}
