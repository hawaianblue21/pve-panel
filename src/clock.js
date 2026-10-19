// The panel's time zone (PANEL_TIMEZONE, default UTC): hours customers and
// administrators choose (automatic snapshots, maintenance windows) are wall-clock
// hours there.

export const TZ = process.env.PANEL_TIMEZONE || 'UTC';
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock parts of a moment in the panel's time zone (wd: 0 = Sunday). */
export function partsIn(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: date.getUTCSeconds(), wd: WEEKDAYS.indexOf(p.weekday) };
}

/**
 * A weekly window: { days: [0..6], start: hour, end: hour }. end ≤ start runs past
 * midnight (22 → 4 on Saturday is Saturday 22:00 to Sunday 04:00).
 */
export function insideWindow(w, date = new Date()) {
  if (!w) return true;
  const { h, wd } = partsIn(date);
  if (w.end > w.start) return w.days.includes(wd) && h >= w.start && h < w.end;
  return (w.days.includes(wd) && h >= w.start) || (w.days.includes((wd + 6) % 7) && h < w.end);
}

const hh = (h) => `${String(h).padStart(2, '0')}:00`;
export function windowText(w) {
  if (!w) return '';
  const days = w.days.length === 7 ? 'every day' : w.days.map((d) => WEEKDAYS[d]).join(', ');
  return `${days} ${hh(w.start)}–${hh(w.end)}${w.end <= w.start ? ' (next day)' : ''} ${TZ}`;
}
