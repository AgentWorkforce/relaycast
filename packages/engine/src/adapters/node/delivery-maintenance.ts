import type { EngineDeps } from '../../ports/index.js';
import { sweepDueNodeDeliveries, sweepExpiredDeliveries } from '../../routes/deliveryRouting.js';

interface DeliveryMaintenanceOperations {
  sweepNodeDeliveries: (deps: EngineDeps) => Promise<unknown>;
  sweepExpiry: (deps: EngineDeps) => Promise<unknown>;
}

/**
 * Serialize delivery maintenance so an in-flight HTTP push cannot be expired
 * while its POST is still pending. Calls made while a cycle is running share
 * that cycle rather than queueing an unbounded maintenance backlog.
 */
export function createDeliveryMaintenanceRunner(
  deps: EngineDeps,
  operations: DeliveryMaintenanceOperations = {
    sweepNodeDeliveries: sweepDueNodeDeliveries,
    sweepExpiry: sweepExpiredDeliveries,
  },
): () => Promise<void> {
  let running: Promise<void> | undefined;

  return () => {
    if (running) return running;

    const cycle = (async () => {
      try {
        await operations.sweepNodeDeliveries(deps);
      } catch (err) {
        deps.telemetry.captureException(err, {
          source: 'node.maintenance',
          op: 'node_delivery',
        });
      }

      try {
        await operations.sweepExpiry(deps);
      } catch (err) {
        deps.telemetry.captureException(err, {
          source: 'node.maintenance',
          op: 'delivery_expiry',
        });
      }
    })();
    running = cycle.finally(() => {
      running = undefined;
    });
    return running;
  };
}
