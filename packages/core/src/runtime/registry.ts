import type { RuntimeDescriptor, RuntimeRegistration } from './descriptor.js';
import type { WorkflowRuntime } from './types.js';

export interface RuntimeRegisterOptions {
  override?: boolean;
}

const STATUS_PRIORITY: Record<RuntimeDescriptor['status'], number> = {
  stable: 0,
  beta: 1,
  alpha: 2,
  experimental: 3,
};

export class RuntimeRegistry {
  private readonly entries = new Map<string, RuntimeRegistration>();

  register(registration: RuntimeRegistration, options: RuntimeRegisterOptions = {}): void {
    if (this.entries.has(registration.descriptor.id) && options.override !== true) {
      throw new Error(`runtime already registered: ${registration.descriptor.id}`);
    }

    this.entries.set(registration.descriptor.id, registration);
  }

  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): RuntimeRegistration | undefined {
    return this.entries.get(id);
  }

  list(): RuntimeDescriptor[] {
    return Array.from(this.entries.values())
      .map((entry) => entry.descriptor)
      .sort((left, right) => {
        const statusOrder = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
        if (statusOrder !== 0) {
          return statusOrder;
        }

        return left.id.localeCompare(right.id);
      });
  }

  async create(id: string, config: unknown): Promise<WorkflowRuntime> {
    const entry = this.entries.get(id);
    if (!entry) {
      const available = this.list()
        .map((descriptor) => descriptor.id)
        .join(', ');
      throw new Error(`unknown runtime: ${id}. Available: ${available}`);
    }

    return entry.factory(config);
  }
}

export const defaultRegistry = new RuntimeRegistry();
