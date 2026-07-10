export class DurableObject {
  protected readonly ctx: DurableObjectState & {
    __setOwner?: (owner: unknown) => void;
  };
  protected readonly env: unknown;

  constructor(
    ctx: DurableObjectState & { __setOwner?: (owner: unknown) => void },
    env: unknown,
  ) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.__setOwner?.(this);
  }
}
