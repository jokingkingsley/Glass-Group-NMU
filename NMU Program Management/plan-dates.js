// Due dates for a new program's template tasks.
//
// A template step says "N days before/after the program starts". When a program is
// created with less lead time than the template expects, the steps before the start
// would land in the past and show up as overdue on day one. Instead, those steps are
// compressed proportionally to fit between today and the start date, keeping their
// order and relative spacing. Steps on or after the start date are never moved.

const DAY = 86400000;
const toTime = (date) => Date.parse(`${date}T12:00:00Z`);
const fromTime = (time) => new Date(time).toISOString().slice(0, 10);
export const daysBetween = (from, to) => Math.round((toTime(to) - toTime(from)) / DAY);
export const addDays = (date, days) => fromTime(toTime(date) + days * DAY);

// offsets: days relative to start (negative = before). Returns { dates, compressed, leadDays, neededDays }.
export function planDueDates(startDate, offsets, today = new Date().toISOString().slice(0, 10)) {
  const earliest = Math.min(0, ...offsets);
  const leadDays = Math.max(0, daysBetween(today, startDate));
  const neededDays = -earliest;
  if (neededDays <= leadDays) return { dates: offsets.map((offset) => addDays(startDate, offset)), compressed: false, leadDays, neededDays };
  const scale = neededDays ? leadDays / neededDays : 1;
  const dates = offsets.map((offset) => {
    if (offset >= 0) return addDays(startDate, offset);
    const date = addDays(startDate, Math.round(offset * scale));
    return date < today ? today : date;
  });
  return { dates, compressed: true, leadDays, neededDays };
}
