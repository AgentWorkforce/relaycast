import type { DeliveryState } from '@relaycast/types';

/**
 * The sender-facing state of a delivery row (see `DeliveryStateSchema` in
 * `@relaycast/types`): failure first, then the strongest signal the recipient
 * gave — a reply, an ack, an acceptance — else queued.
 *
 * `delivered` requires `accepted_at`: the receiving software's own receipt
 * (`delivery.accepted`, or an `http_push` 2xx). A host-side socket write sets
 * the raw `status` to `delivered` (compatibility) but proves nothing about the
 * client, so it stays `queued` here.
 */
export function deliveryStateOf(row: {
  status: string;
  acceptedAt?: Date | string | null;
  repliedAt?: Date | string | null;
}): DeliveryState {
  if (row.status === 'failed' || row.status === 'dead_lettered') return 'failed';
  if (row.repliedAt) return 'replied';
  if (row.status === 'acked') return 'consumed';
  if (row.acceptedAt) return 'delivered';
  return 'queued';
}
