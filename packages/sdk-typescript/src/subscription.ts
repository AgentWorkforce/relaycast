export interface Subscription {
  readonly channels: string[];
  unsubscribe(): void;
}
