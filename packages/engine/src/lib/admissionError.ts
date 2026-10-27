import type { AdmissionDenial } from '../ports/admission.js';

/**
 * Thrown from inside a route when a fresh send was already refused by the
 * host's admission hook (see `middleware/admission.ts`). `errorResponse`
 * renders the carried denial with its status and additive fields.
 */
export class AdmissionDeniedError extends Error {
  constructor(readonly denial: AdmissionDenial) {
    super(denial.message);
    this.name = 'AdmissionDeniedError';
  }
}
