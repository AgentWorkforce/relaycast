import { describe, expect, it } from 'vitest';
import { redactOwnerApprovalQuote, type OwnerApprovalQuoteRedaction } from '../index.js';
import { redactOwnerApprovalQuote as internal } from '../engine/ownerApproval.js';

// The hosted gateway serves the redact-quote internal route by calling this
// function from the public entry; pin that the export is the same function.
describe('redactOwnerApprovalQuote (public export)', () => {
  it('is the same function the internal route uses', () => {
    expect(redactOwnerApprovalQuote).toBe(internal);
  });

  it('exposes the result type', () => {
    const r: OwnerApprovalQuoteRedaction = { message_id: 'm', quote_redacted_at: 't', already_redacted: false };
    expect(r.already_redacted).toBe(false);
  });
});
