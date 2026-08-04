function normalizedDateKey(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return '';
  }

  const normalized = text.replace(/[年月.\-]/g, '/').replace(/日/g, '').replace(/\/+/g, '/');
  const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) {
    return normalized;
  }
  return `${Number(match[1])}/${Number(match[2])}/${Number(match[3])}`;
}

export function orderRowsByDateBatch(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = normalizedDateKey(row?.date);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareDateKeys(left, right))
    .flatMap(([, group]) => group);
}

export function dateBatchKeys(rows) {
  return [...new Set(rows.map((row) => normalizedDateKey(row?.date)))];
}

function compareDateKeys(left, right) {
  const leftTime = dateKeyTime(left);
  const rightTime = dateKeyTime(right);
  if (leftTime !== null && rightTime !== null) {
    return leftTime - rightTime;
  }
  if (leftTime !== null) {
    return -1;
  }
  if (rightTime !== null) {
    return 1;
  }
  return left.localeCompare(right);
}

function dateKeyTime(value) {
  const match = String(value).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) {
    return null;
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}
