import { createHmac, timingSafeEqual } from 'crypto';

export interface ShopeeBridgeClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ShopeeBridgeScreenshot {
  data: Buffer;
  contentType: string;
  updatedAt: string;
}

export interface ShopeeBridgeSnapshot {
  health: Record<string, unknown>;
  events: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  screenshot?: ShopeeBridgeScreenshot;
  screenshotMissing: boolean;
  warnings: string[];
  fetchedAt: string;
}

export function verifyShopeeBridgeSignature(
  payload: Buffer,
  header: string | undefined,
  secret: string
): boolean {
  if (!header || !secret) return false;
  const provided = (header.startsWith('sha256=') ? header.slice(7) : header).trim();
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const candidate = Buffer.from(provided, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export class ShopeeBridgeError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ShopeeBridgeError';
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new ShopeeBridgeError(`Shopee bridge returned an invalid ${field} payload`);
  }
  return value.filter(isRecord);
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SHOPEE_BRIDGE_URL must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('SHOPEE_BRIDGE_URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('SHOPEE_BRIDGE_URL must not include credentials, query, or hash');
  }
  return url.toString().replace(/\/$/, '');
}

export class ShopeeBridgeClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ShopeeBridgeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 100) {
      throw new Error('Shopee bridge timeout must be at least 100ms');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<Record<string, unknown>> {
    const data = await this.getJson('/health');
    if (!isRecord(data)) {
      throw new ShopeeBridgeError('Shopee bridge returned an invalid health payload');
    }
    return data;
  }

  async events(limit = 50): Promise<Record<string, unknown>[]> {
    const data = await this.getJson(`/events?limit=${this.limit(limit)}`);
    if (!isRecord(data)) {
      throw new ShopeeBridgeError('Shopee bridge returned an invalid events payload');
    }
    return asArray(data.events, 'events');
  }

  async orders(limit = 50): Promise<Record<string, unknown>[]> {
    const data = await this.getJson(`/orders?limit=${this.limit(limit)}`);
    if (!isRecord(data)) {
      throw new ShopeeBridgeError('Shopee bridge returned an invalid orders payload');
    }
    return asArray(data.orders, 'orders');
  }

  async screenshot(): Promise<ShopeeBridgeScreenshot | undefined> {
    const response = await this.request('/area/latest.png', 'image/png');
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ShopeeBridgeError(
        `Shopee bridge screenshot request failed with HTTP ${response.status}`,
        response.status
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/png')) {
      await response.body?.cancel().catch(() => undefined);
      throw new ShopeeBridgeError('Shopee bridge screenshot is not image/png');
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > 8 * 1024 * 1024) {
      await response.body?.cancel().catch(() => undefined);
      throw new ShopeeBridgeError('Shopee bridge screenshot is too large');
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > 8 * 1024 * 1024) {
      throw new ShopeeBridgeError('Shopee bridge screenshot is too large');
    }
    if (data.length < 8 || data[0] !== 0x89 || data.toString('ascii', 1, 4) !== 'PNG') {
      throw new ShopeeBridgeError('Shopee bridge screenshot is not a PNG image');
    }
    return {
      data,
      contentType: 'image/png',
      updatedAt: new Date().toISOString()
    };
  }

  async snapshot(): Promise<ShopeeBridgeSnapshot> {
    const health = await this.health();
    const results = await Promise.allSettled([
      this.events(50),
      this.orders(50),
      this.screenshot()
    ]);
    const warnings: string[] = [];
    const eventsResult = results[0]!;
    const ordersResult = results[1]!;
    const screenshotResult = results[2]!;

    if (eventsResult.status === 'rejected') {
      warnings.push(`events: ${this.errorMessage(eventsResult.reason)}`);
    }
    if (ordersResult.status === 'rejected') {
      warnings.push(`orders: ${this.errorMessage(ordersResult.reason)}`);
    }
    if (screenshotResult.status === 'rejected') {
      warnings.push(`screenshot: ${this.errorMessage(screenshotResult.reason)}`);
    }

    const screenshot =
      screenshotResult.status === 'fulfilled' ? screenshotResult.value : undefined;

    return {
      health,
      events: eventsResult.status === 'fulfilled' ? eventsResult.value : [],
      orders: ordersResult.status === 'fulfilled' ? ordersResult.value : [],
      screenshot,
      screenshotMissing: screenshotResult.status === 'fulfilled' && screenshot === undefined,
      warnings,
      fetchedAt: new Date().toISOString()
    };
  }

  private limit(value: number): number {
    if (!Number.isInteger(value) || value < 1) return 50;
    return Math.min(value, 200);
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.request(path, 'application/json');
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ShopeeBridgeError(
        `Shopee bridge ${path} failed with HTTP ${response.status}`,
        response.status
      );
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ShopeeBridgeError(`Shopee bridge ${path} returned invalid JSON`);
    }
  }

  private async request(path: string, accept: string): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { accept },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new ShopeeBridgeError(`Shopee bridge ${path} timed out`);
      }
      throw new ShopeeBridgeError(
        `Shopee bridge ${path} is unreachable: ${this.errorMessage(error)}`
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
