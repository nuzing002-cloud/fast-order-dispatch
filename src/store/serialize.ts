export const DATE_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'assignedAt',
  'pickedUpAt',
  'deliveredAt',
  'estimatedDeliveryTime',
  'queuedAt',
  'lastLocationUpdate',
  'startedAt',
  'completedAt',
  'processedAt',
  'timestamp'
]);

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (DATE_KEYS.has(key) && typeof entry === 'string') {
        const date = new Date(entry);
        result[key] = Number.isNaN(date.getTime()) ? entry : date;
      } else {
        result[key] = revive(entry);
      }
    }
    return result;
  }
  return value;
}

export function parseJson<T>(value: string | unknown): T {
  const source = typeof value === 'string' ? JSON.parse(value) : value;
  return revive(source) as T;
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}
