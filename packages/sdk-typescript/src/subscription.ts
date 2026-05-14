export interface Subscription {
  readonly channels: readonly string[];
  unsubscribe(): void;
}
