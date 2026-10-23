import { createHash } from 'crypto';
import {
  ShopeeBridgeClient,
  ShopeeBridgeScreenshot
} from './ShopeeBridgeClient';

export interface ShopeeBridgeServiceOptions {
  client: ShopeeBridgeClient;
  syncIntervalMs?: number;
  staleAfterMs?: number;
}

export interface ShopeeBridgeScreenshotMeta {
  available: boolean;
  bytes: number;
  updatedAt: string | null;
}

export interface ShopeeBridgeStatus {
  configured: true;
  capability: 'read-only';
  baseUrl: string;
  reachable: boolean;
  syncIntervalMs: number;
  staleAfterMs: number;
  lastAttemptAt: string | null;
  lastSyncAt: string | null;
  lastEventAt: string | null;
  lastWebhookAt: string | null;
  lastRefreshSucceeded: boolean;
  lastError: string | null;
  health: Record<string, unknown> | null;
  events: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  screenshot: ShopeeBridgeScreenshotMeta;
  dataFreshness: ShopeeBridgeFreshness;
  safety: {
    commandsExposed: false;
    autoAcceptOwner: 'shopee-bridge';
    note: string;
  };
}

export type ShopeeBridgeFreshnessState = 'fresh' | 'stale' | 'unknown' | 'offline';

export interface ShopeeBridgeFreshness {
  state: ShopeeBridgeFreshnessState;
  stale: boolean;
  ageMs: number | null;
  thresholdMs: number;
  observedAt: string | null;
  source: 'health' | 'webhook' | 'none';
  reason: string;
}

export interface ShopeeBridgeEventResult {
  id: string;
  duplicate: boolean;
}

const MAX_EVENTS = 100;
const MAX_REMEMBERED_EVENTS = 500;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

function eventIdentity(event: Record<string, unknown>): string {
  if (typeof event.id === 'string' && event.id.trim().length > 0) {
    return `id:${event.id.trim()}`;
  }
  const parts = [event.type, event.time, event.key, event.title, event.text].map((value) =>
    typeof value === 'string' ? value : ''
  );
  return `hash:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

function eventTime(event: Record<string, unknown>): number {
  if (typeof event.time !== 'string') return 0;
  const parsed = Date.parse(event.time);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ShopeeBridgeService {
  private readonly client: ShopeeBridgeClient;
  private readonly syncIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly rememberedEvents = new Set<string>();
  private health: Record<string, unknown> | null = null;
  private events: Record<string, unknown>[] = [];
  private orders: Record<string, unknown>[] = [];
  private screenshot: ShopeeBridgeScreenshot | undefined;
  private lastAttemptAt: string | null = null;
  private lastSyncAt: string | null = null;
  private lastEventAt: string | null = null;
  private lastWebhookAt: string | null = null;
  private lastRefreshSucceeded = false;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<ShopeeBridgeStatus> | null = null;

  constructor(options: ShopeeBridgeServiceOptions) {
    this.client = options.client;
    this.syncIntervalMs = options.syncIntervalMs ?? 15_000;
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
    if (!Number.isInteger(this.syncIntervalMs) || this.syncIntervalMs < 1_000) {
      throw new Error('Shopee bridge sync interval must be at least 1000ms');
    }
    if (!Number.isInteger(this.staleAfterMs) || this.staleAfterMs < 1_000) {
      throw new Error('Shopee bridge stale threshold must be at least 1000ms');
    }
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.syncIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh(): Promise<ShopeeBridgeStatus> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  ingestEvent(event: Record<string, unknown>): ShopeeBridgeEventResult {
    this.lastWebhookAt = new Date().toISOString();
    const id = eventIdentity(event);
    if (this.rememberedEvents.has(id)) {
      return { id, duplicate: true };
    }
    this.rememberedEvents.add(id);
    this.events = [event, ...this.events].slice(0, MAX_EVENTS);
    if (this.rememberedEvents.size > MAX_REMEMBERED_EVENTS) {
      this.rememberedEvents.clear();
      for (const known of this.events) this.rememberedEvents.add(eventIdentity(known));
    }
    const time = typeof event.time === 'string' ? event.time : new Date().toISOString();
    this.lastEventAt = time;
    return { id, duplicate: false };
  }

  status(): ShopeeBridgeStatus {
    return {
      configured: true,
      capability: 'read-only',
      baseUrl: this.client.baseUrl,
      reachable: this.lastRefreshSucceeded && this.health !== null && this.health.ok === true,
      syncIntervalMs: this.syncIntervalMs,
      staleAfterMs: this.staleAfterMs,
      lastAttemptAt: this.lastAttemptAt,
      lastSyncAt: this.lastSyncAt,
      lastEventAt: this.lastEventAt,
      lastWebhookAt: this.lastWebhookAt,
      lastRefreshSucceeded: this.lastRefreshSucceeded,
      lastError: this.lastError,
      health: this.health,
      events: this.events,
      orders: this.orders,
      screenshot: {
        available: this.screenshot !== undefined,
        bytes: this.screenshot?.data.length ?? 0,
        updatedAt: this.screenshot?.updatedAt ?? null
      },
      dataFreshness: this.dataFreshness(),
      safety: {
        commandsExposed: false,
        autoAcceptOwner: 'shopee-bridge',
        note: '3000 is read-only for the Shopee bridge; open/accept commands are not exposed'
      }
    };
  }

  getScreenshot(): ShopeeBridgeScreenshot | undefined {
    return this.screenshot;
  }

  private async runRefresh(): Promise<ShopeeBridgeStatus> {
    this.lastAttemptAt = new Date().toISOString();
    try {
      const snapshot = await this.client.snapshot();
      this.lastRefreshSucceeded = true;
      this.health = snapshot.health;
      this.mergeEvents(snapshot.events);
      this.orders = snapshot.orders;
      if (snapshot.screenshot) {
        const changed =
          !this.screenshot || !this.screenshot.data.equals(snapshot.screenshot.data);
        if (changed && snapshot.screenshot.data.length <= MAX_SCREENSHOT_BYTES) {
          this.screenshot = snapshot.screenshot;
        }
      } else if (snapshot.screenshotMissing) {
        this.screenshot = undefined;
      }
      this.lastSyncAt = snapshot.fetchedAt;
      this.lastError = snapshot.warnings.length > 0 ? snapshot.warnings.join('; ') : null;
    } catch (error) {
      this.lastRefreshSucceeded = false;
      this.orders = [];
      this.screenshot = undefined;
      this.lastError = errorMessage(error);
    }
    return this.status();
  }

  private mergeEvents(incoming: Record<string, unknown>[]): void {
    const merged = new Map<string, Record<string, unknown>>();
    for (const event of [...this.events, ...incoming]) {
      const id = eventIdentity(event);
      if (!merged.has(id)) merged.set(id, event);
      this.rememberedEvents.add(id);
    }
    this.events = [...merged.values()]
      .sort((left, right) => eventTime(right) - eventTime(left))
      .slice(0, MAX_EVENTS);
    if (this.rememberedEvents.size > MAX_REMEMBERED_EVENTS) {
      this.rememberedEvents.clear();
      for (const event of this.events) this.rememberedEvents.add(eventIdentity(event));
    }
  }

  private dataFreshness(): ShopeeBridgeFreshness {
    if (!this.lastRefreshSucceeded || this.health?.ok !== true) {
      return {
        state: 'offline',
        stale: true,
        ageMs: null,
        thresholdMs: this.staleAfterMs,
        observedAt: null,
        source: 'none',
        reason: 'bridge health is unavailable or the latest refresh failed'
      };
    }

    const healthObservedAt = healthTimestamp(this.health);
    const webhookObservedAt = parseTimestamp(this.lastWebhookAt);
    const observed = healthObservedAt
      ? { ...healthObservedAt, source: 'health' as const }
      : webhookObservedAt
        ? { ...webhookObservedAt, source: 'webhook' as const }
        : null;

    if (!observed) {
      return {
        state: 'unknown',
        stale: false,
        ageMs: null,
        thresholdMs: this.staleAfterMs,
        observedAt: null,
        source: 'none',
        reason: 'bridge health did not provide a usable timestamp'
      };
    }

    const ageMs = Math.max(0, Date.now() - observed.timeMs);
    const stale = ageMs > this.staleAfterMs;
    return {
      state: stale ? 'stale' : 'fresh',
      stale,
      ageMs,
      thresholdMs: this.staleAfterMs,
      observedAt: observed.value,
      source: observed.source,
      reason: stale
        ? `latest bridge data is ${Math.round(ageMs / 1000)}s old`
        : 'latest bridge data is within the freshness threshold'
    };
  }
}

function parseTimestamp(value: unknown): { value: string; timeMs: number } | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const timeMs = Date.parse(value);
  return Number.isFinite(timeMs) ? { value, timeMs } : null;
}

function healthTimestamp(health: Record<string, unknown>): { value: string; timeMs: number } | null {
  for (const key of ['lastPollAt', 'lastUpdatedAt', 'updatedAt', 'lastSeenAt', 'timestamp']) {
    const timestamp = parseTimestamp(health[key]);
    if (timestamp) return timestamp;
  }
  return null;
}
