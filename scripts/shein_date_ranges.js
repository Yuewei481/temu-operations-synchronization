const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RANGE_DAYS = 31;

export function parseSheinTargetDates(env = process.env, now = new Date()) {
  const raw = String(env.SHEIN_TARGET_DATES || '').trim();
  if (!raw) {
    return [formatShanghaiDate(new Date(now.getTime() - ONE_DAY_MS))];
  }

  const dates = raw
    .split(',')
    .map((value) => normalizeIsoDate(value))
    .filter(Boolean);
  if (!dates.length) {
    throw new Error('SHEIN_TARGET_DATES must contain at least one valid YYYY-MM-DD date.');
  }
  return [...new Set(dates)].sort();
}

export function groupSheinDateRanges(dates, maxRangeDays = DEFAULT_MAX_RANGE_DAYS) {
  if (!Number.isInteger(maxRangeDays) || maxRangeDays < 1) {
    throw new Error('SHEIN maximum range days must be a positive integer.');
  }

  const normalizedDates = [...new Set((dates || []).map(normalizeIsoDate).filter(Boolean))].sort();
  const ranges = [];
  let current = null;

  for (const date of normalizedDates) {
    if (!current) {
      current = { start: date, end: date, dates: [date] };
      continue;
    }

    const previousDate = current.dates[current.dates.length - 1];
    const isContiguous = daysBetween(previousDate, date) === 1;
    const rangeDays = daysBetween(current.start, date) + 1;
    if (isContiguous && rangeDays <= maxRangeDays) {
      current.end = date;
      current.dates.push(date);
      continue;
    }

    ranges.push(current);
    current = { start: date, end: date, dates: [date] };
  }

  if (current) {
    ranges.push(current);
  }
  return ranges;
}

export function normalizeIsoDate(value) {
  const text = String(value || '').trim().replace(/[/.]/g, '-');
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!match) {
    return '';
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return '';
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysBetween(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / ONE_DAY_MS);
}

function formatShanghaiDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
