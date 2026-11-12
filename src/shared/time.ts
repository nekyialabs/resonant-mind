/**
 * Time-of-day context + relative time formatting.
 *
 * Used in orient + ground rendering to colour the wake-up output with
 * temporal texture (morning, afternoon, etc.) and to display "5m ago"-style
 * timestamps next to notes and journal entries.
 */

export interface TimeContext {
  period: string;
  energy: string;
  textures: string[];
}

export function getTimeOfDayContext(timeZone = "UTC"): TimeContext {
  const now = new Date();
  let hour: number;
  try {
    hour = Number(new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now));
  } catch {
    hour = now.getUTCHours();
  }

  if (hour >= 5 && hour < 10) {
    return { period: "morning", energy: "rising", textures: ["fresh", "possibility", "beginning"] };
  } else if (hour >= 10 && hour < 14) {
    return { period: "midday", energy: "active", textures: ["focused", "momentum", "present"] };
  } else if (hour >= 14 && hour < 18) {
    return { period: "afternoon", energy: "sustained", textures: ["working", "steady", "deep"] };
  } else if (hour >= 18 && hour < 22) {
    return { period: "evening", energy: "winding down", textures: ["unwinding", "reflective", "intimate"] };
  } else {
    return { period: "night", energy: "quiet", textures: ["hushed", "still", "dreaming"] };
  }
}

/** The night runs 22:00 to 05:00 local; hours before this belong to the night that began the evening before. */
const NIGHT_END_HOUR = 5;

/**
 * The calendar date (YYYY-MM-DD) of the night a moment belongs to, in a zone.
 * A night that starts at 22:00 on local day D, including the hours after
 * midnight up to 05:00, is night D. Hours from 05:00 to 21:59 are dated by
 * their own local day. An invalid zone falls back to UTC.
 */
export function nightDateFor(now: Date = new Date(), timeZone = "UTC"): string {
  const { date, hour } = localDateAndHour(now, timeZone);
  return hour < NIGHT_END_HOUR ? shiftDate(date, -1) : date;
}

/** A YYYY-MM-DD calendar date moved by a whole number of days. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function localDateAndHour(now: Date, timeZone: string): { date: string; hour: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return localDateAndHour(now, "UTC");
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

export function getRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
}
