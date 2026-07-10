import { CronExpressionParser } from "cron-parser";

export function getNextCronDate(
  expression: string,
  timezone: string
): Date | null {
  try {
    const cron = CronExpressionParser.parse(expression, {
      currentDate: new Date(),
      tz: timezone,
    });
    return cron.next().toDate();
  } catch {
    return null;
  }
}

export function isValidCron(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression);
    return true;
  } catch {
    return false;
  }
}
