export interface KpiRange {
  from: Date;
  to: Date;
}

export interface KpiReport {
  range: { from: string; to: string };
  totals: {
    ordersCreated: number;
    delivered: number;
    cancelled: number;
    failed: number;
    inProgress: number;
    successRate: number;
    onTimeRate: number;
    avgQueueWaitMs: number;
    avgPickupMs: number;
    avgDeliveryMs: number;
    revenue: number;
    deliveryFees: number;
    avgOrderValue: number;
  };
  perDay: Array<{
    date: string;
    ordersCreated: number;
    delivered: number;
    revenue: number;
  }>;
  perDriver: Array<{
    driverId: string;
    delivered: number;
    avgDeliveryMs: number;
    deliveryFees: number;
    earnings: number;
  }>;
}

export function bangkokDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function bangkokDateKeys(from: Date, to: Date): string[] {
  const fromKey = bangkokDateKey(from);
  const toKey = bangkokDateKey(to);
  const cursor = new Date(`${fromKey}T00:00:00.000Z`);
  const last = Date.parse(`${toKey}T00:00:00.000Z`);
  const dates: string[] = [];

  while (cursor.getTime() <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}
