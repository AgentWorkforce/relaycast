export type NextFireSchedule = {
  id?: string;
  cronExpression: string | null;
  timezone: string;
};

type ParsedCronField = {
  values: Set<number> | null;
};

type ParsedCronExpression = {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
};

const CRON_SEARCH_WINDOW_MINUTES = 370 * 24 * 60;
const TIME_ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function parseCronField(part: string, min: number, max: number, options?: { sevenIsZero?: boolean }): ParsedCronField | null {
  const trimmed = part.trim();
  if (trimmed === "*") {
    return { values: null };
  }

  const values = new Set<number>();
  for (const rawToken of trimmed.split(",")) {
    const token = rawToken.trim();
    if (!token) return null;
    const [rangeToken, stepToken] = token.split("/");
    const step = stepToken ? Number(stepToken) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;

    let rangeStart: number;
    let rangeEnd: number;
    if (rangeToken === "*") {
      rangeStart = min;
      rangeEnd = max;
    } else if (rangeToken.includes("-")) {
      const [start, end] = rangeToken.split("-").map(Number);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
      rangeStart = start;
      rangeEnd = end;
    } else {
      const value = Number(rangeToken);
      if (!Number.isInteger(value)) return null;
      rangeStart = value;
      rangeEnd = value;
    }

    for (let value = rangeStart; value <= rangeEnd; value += step) {
      const normalized = options?.sevenIsZero && value === 7 ? 0 : value;
      if (normalized < min || normalized > max) return null;
      values.add(normalized);
    }
  }

  return { values };
}

function parseCronExpression(expression: string): ParsedCronExpression | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const minuteField = parseCronField(minute, 0, 59);
  const hourField = parseCronField(hour, 0, 23);
  const dayOfMonthField = parseCronField(dayOfMonth, 1, 31);
  const monthField = parseCronField(month, 1, 12);
  const dayOfWeekField = parseCronField(dayOfWeek, 0, 6, { sevenIsZero: true });
  if (!minuteField || !hourField || !dayOfMonthField || !monthField || !dayOfWeekField) {
    return null;
  }
  return {
    minute: minuteField,
    hour: hourField,
    dayOfMonth: dayOfMonthField,
    month: monthField,
    dayOfWeek: dayOfWeekField,
  };
}

function fieldMatches(field: ParsedCronField, value: number) {
  return field.values === null || field.values.has(value);
}

function getTimeZoneFormatter(timezone: string) {
  const cached = TIME_ZONE_FORMATTERS.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
  }
  TIME_ZONE_FORMATTERS.set(timezone, formatter);
  return formatter;
}

function getTimeZoneParts(date: Date, timezone: string) {
  const values = Object.fromEntries(
    getTimeZoneFormatter(timezone)
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const weekday = String(values.weekday ?? "").toLowerCase().slice(0, 3);
  const dayOfWeek = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(weekday);
  return {
    minute: Number(values.minute),
    hour: Number(values.hour),
    dayOfMonth: Number(values.day),
    month: Number(values.month),
    dayOfWeek,
  };
}

function cronMatchesDate(parsed: ParsedCronExpression, date: Date, timezone: string) {
  const parts = getTimeZoneParts(date, timezone);
  const dayOfMonthMatches = fieldMatches(parsed.dayOfMonth, parts.dayOfMonth);
  const dayOfWeekMatches = fieldMatches(parsed.dayOfWeek, parts.dayOfWeek);
  const dayMatches =
    parsed.dayOfMonth.values !== null && parsed.dayOfWeek.values !== null
      ? dayOfMonthMatches || dayOfWeekMatches
      : dayOfMonthMatches && dayOfWeekMatches;

  return (
    fieldMatches(parsed.minute, parts.minute) &&
    fieldMatches(parsed.hour, parts.hour) &&
    fieldMatches(parsed.month, parts.month) &&
    dayMatches
  );
}

function getNextCronFire(cronExpression: string | null | undefined, timezone: string, after: Date) {
  if (!cronExpression) return null;
  const parsed = parseCronExpression(cronExpression);
  if (!parsed) return null;

  let candidateTime = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let checked = 0; checked < CRON_SEARCH_WINDOW_MINUTES; checked += 1) {
    const candidate = new Date(candidateTime);
    if (cronMatchesDate(parsed, candidate, timezone)) {
      return candidate;
    }
    candidateTime += 60_000;
  }
  return null;
}

export function getNextAgentFire(schedules: NextFireSchedule[], after = new Date()) {
  const nextFires = schedules
    .map((schedule) => getNextCronFire(schedule.cronExpression, schedule.timezone, after))
    .filter((date): date is Date => Boolean(date));
  if (nextFires.length === 0) return null;
  return nextFires.reduce((soonest, date) => (date.getTime() < soonest.getTime() ? date : soonest));
}

export function formatNextFireRelative(date: Date, now = new Date()) {
  const diffMinutes = Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 60_000));
  if (diffMinutes < 1) return "in <1m";
  if (diffMinutes < 60) return `in ${diffMinutes}m`;
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  if (hours < 24) return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `in ${days}d ${remainingHours}h` : `in ${days}d`;
}
