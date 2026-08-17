/**
 * Working-day arithmetic for service-level deadlines.
 *
 * A dispute mechanism without a resolution deadline is not a remedy, so the
 * deadlines are computed and stored on the record rather than left to whoever
 * looks at the queue. Storing them means an overdue item is overdue in the
 * data, visible to a query, rather than requiring someone to notice.
 *
 * Weekends are excluded. Indonesian public holidays are not modelled — the
 * national calendar includes movable religious holidays and government-declared
 * collective leave that are published year by year, so they are supplied as
 * configuration rather than hardcoded to a guess. Absent that list, a deadline
 * computed here is slightly tighter than the true obligation, which is the safe
 * direction to be wrong in.
 */

const MS_PER_DAY = 86_400_000;

/** Holidays supplied by configuration, as `YYYY-MM-DD` strings. */
function holidaySet(holidays = process.env.PUBLIC_HOLIDAYS) {
    if (!holidays) return new Set();
    const list = Array.isArray(holidays) ? holidays : String(holidays).split(',');
    return new Set(list.map((day) => day.trim()).filter(Boolean));
}

function isoDay(date) {
    return date.toISOString().slice(0, 10);
}

function isWorkingDay(date, holidays) {
    const day = date.getUTCDay();
    if (day === 0 || day === 6) return false;
    return !holidays.has(isoDay(date));
}

/**
 * The date `count` working days after `from`.
 *
 * Counts forward one day at a time rather than by arithmetic on the weekday
 * index, because the holiday list makes the sequence irregular and an
 * expression that assumes a five-day rhythm silently drifts once it is applied.
 */
function addWorkingDays(from, count, { holidays } = {}) {
    const set = holidaySet(holidays);
    const result = new Date(from.getTime());
    let remaining = Math.max(0, count);
    while (remaining > 0) {
        result.setTime(result.getTime() + MS_PER_DAY);
        if (isWorkingDay(result, set)) remaining -= 1;
    }
    return result;
}

/**
 * Working days elapsed between two moments, excluding the starting day.
 *
 * Used to report how long a subject has actually been waiting, which is the
 * number that belongs in a service-level report — not the calendar span, which
 * flatters the figure by roughly a third.
 */
function workingDaysBetween(from, to, { holidays } = {}) {
    if (to <= from) return 0;
    const set = holidaySet(holidays);
    const cursor = new Date(from.getTime());
    let elapsed = 0;
    while (cursor < to) {
        cursor.setTime(cursor.getTime() + MS_PER_DAY);
        if (cursor <= to && isWorkingDay(cursor, set)) elapsed += 1;
    }
    return elapsed;
}

module.exports = { addWorkingDays, workingDaysBetween, isWorkingDay, holidaySet };
