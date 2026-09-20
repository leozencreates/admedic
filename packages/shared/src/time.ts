/** YYYY-MM-DD biciminde UTC tarih anahtarı. */
export function dateKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function nowUTC(): Date {
  return new Date();
}

export function daysAgo(n: number, from = new Date()): Date {
  return new Date(from.getTime() - n * 86400_000);
}

export function toStartOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function toEndOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000);
}

export interface TimeWindow {
  label: string;
  since: Date;
  until: Date;
}

export const timeWindows = (from = new Date()): TimeWindow[] => [
  { label: "Today", since: toStartOfDay(from), until: new Date(from) },
  { label: "Yesterday", since: toStartOfDay(daysAgo(1, from)), until: toEndOfDay(daysAgo(1, from)) },
  { label: "Last 24 Hours", since: daysAgo(1, from), until: new Date(from) },
  { label: "Last 3 Days", since: daysAgo(3, from), until: new Date(from) },
  { label: "Last 7 Days", since: daysAgo(7, from), until: new Date(from) },
  { label: "Last 14 Days", since: daysAgo(14, from), until: new Date(from) },
  { label: "Last 30 Days", since: daysAgo(30, from), until: new Date(from) },
];