export class DurableObject {
  protected readonly ctx: DurableObjectState;
  protected readonly env: unknown;

  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
