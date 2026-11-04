import type { DeliveryState } from '@relaycast/types';

/**
 * The sender-facing state of a delivery row (see `DeliveryStateSchema` in
 * `@relaycast/types`): failure first, then the strongest signal the recipient
 * gave — a reply, an ack, an acceptance or host-side delivery — else queued.
 */
export function deliveryStateOf(row: {
  status: string;
  acceptedAt?: Date | string | null;
  deliveredAt?: Date | string | null;
  repliedAt?: Date | string | null;
}): DeliveryState {
  if (row.status === 'failed' || row.status === 'dead_lettered') return 'failed';
  if (row.repliedAt) return 'replied';
  if (row.status === 'acked') return 'consumed';
  if (row.acceptedAt || row.deliveredAt || row.status === 'delivered') return 'delivered';
  return 'queued';
}
