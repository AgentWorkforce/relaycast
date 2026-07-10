import { describe, expect, it } from 'vitest';
import {
  REQUIRED_SPECIALIST_BINDINGS,
  checkRequiredSpecialistBindings,
} from './require-bindings.js';

const presentAllRequired = () => {
  const bindings: Record<string, string | undefined> = {};
  for (const name of REQUIRED_SPECIALIST_BINDINGS) bindings[name] = 'x';
  return bindings;
};

describe('checkRequiredSpecialistBindings', () => {
  it('returns null when every required binding is a non-empty string', () => {
    expect(checkRequiredSpecialistBindings(presentAllRequired())).toBeNull();
  });

  it('reports every missing binding by name', () => {
    const partial = presentAllRequired();
    delete partial.OPENROUTER_API_KEY;
    delete partial.SPECIALIST_RELAYAUTH_API_KEY;

    const report = checkRequiredSpecialistBindings(partial);

    expect(report).not.toBeNull();
    expect(report?.missing).toEqual(
      expect.arrayContaining(['OPENROUTER_API_KEY', 'SPECIALIST_RELAYAUTH_API_KEY']),
    );
  });

  it('treats empty and whitespace-only values as missing (not merely undefined)', () => {
    const empty = presentAllRequired();
    empty.SPECIALIST_RELAYAUTH_API_KEY = '';
    empty.OPENROUTER_API_KEY = '   ';

    const report = checkRequiredSpecialistBindings(empty);

    expect(report).not.toBeNull();
    expect(report?.missing).toEqual(
      expect.arrayContaining(['OPENROUTER_API_KEY', 'SPECIALIST_RELAYAUTH_API_KEY']),
    );
  });

  it("handles an undefined bindings argument without throwing", () => {
    const report = checkRequiredSpecialistBindings(undefined);
    expect(report).not.toBeNull();
    expect(report?.missing.length).toBe(REQUIRED_SPECIALIST_BINDINGS.length);
  });

  it('error carries specialist_configuration_error code for upstream handling', () => {
    const partial = presentAllRequired();
    delete partial.SPECIALIST_RELAYAUTH_URL;

    const report = checkRequiredSpecialistBindings(partial);

    expect(report).not.toBeNull();
    expect((report?.configError as { code?: string }).code).toBe('specialist_configuration_error');
    expect(report?.configError.message).toContain('SPECIALIST_RELAYAUTH_URL');
  });
});
