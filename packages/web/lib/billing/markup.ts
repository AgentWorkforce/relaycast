const MARKUP_NUMERATOR = 30n;
const MARKUP_DENOMINATOR = 100n;

export function markupOnly(costUsdMicros: bigint): bigint {
  return (costUsdMicros * MARKUP_NUMERATOR) / MARKUP_DENOMINATOR;
}

export function applyMarkup(costUsdMicros: bigint): bigint {
  return costUsdMicros + markupOnly(costUsdMicros);
}
