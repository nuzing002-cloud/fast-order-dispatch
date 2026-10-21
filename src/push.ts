import webpush from 'web-push';
import { ValidationError } from './errors';
import { logger } from './logger';
import { BatchProcessingService } from './services/BatchProcessingService';
import { DispatchStore } from './store/DispatchStore';
import { BatchAssignment, PushSubscriptionRecord } from './types/order';

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

export type PushSendResult = 'ok' | 'gone' | 'error';

export type PushSender = (
  subscription: PushSubscriptionRecord,
  payload: PushPayload
) => Promise<PushSendResult>;

export interface PushNotifierOptions {
  publicKey: string;
  privateKey: string;
  subject: string;
  sender?: PushSender;
}

export interface VapidConfig {
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
}

export class PushNotifier {
  private readonly sender: PushSender;
  private bound = false;

  constructor(
    private readonly store: DispatchStore,
    private readonly options: PushNotifierOptions
  ) {
    this.sender = options.sender ?? createWebPushSender(options);
  }

  getPublicKey(): string {
    return this.options.publicKey;
  }

  async subscribe(driverId: string, input: PushSubscriptionInput): Promise<PushSubscriptionRecord> {
    if (
      typeof input.endpoint !== 'string' ||
      input.endpoint.length < 8 ||
      !input.keys ||
      typeof input.keys.p256dh !== 'string' ||
      input.keys.p256dh.length < 8 ||
      typeof input.keys.auth !== 'string' ||
      input.keys.auth.length < 4
    ) {
      throw new ValidationError('subscription must contain endpoint and valid p256dh/auth keys');
    }

    const record: PushSubscriptionRecord = {
      endpoint: input.endpoint,
      driverId,
      keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
      createdAt: new Date()
    };
    await this.store.savePushSubscription(record);
    return record;
  }

  async unsubscribe(endpoint: string): Promise<boolean> {
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      throw new ValidationError('endpoint is required');
    }
    return this.store.deletePushSubscription(endpoint);
  }

  async notifyDriver(driverId: string, payload: PushPayload): Promise<number> {
    const subscriptions = await this.store.getPushSubscriptions(driverId);
    let delivered = 0;
    for (const subscription of subscriptions) {
      const result = await this.sender(subscription, payload).catch(() => 'error' as const);
      if (result === 'ok') delivered += 1;
      if (result === 'gone') {
        await this.store.deletePushSubscription(subscription.endpoint).catch(() => false);
      }
    }
    return delivered;
  }

  bindService(service: BatchProcessingService): void {
    if (this.bound) return;
    this.bound = true;
    service.on('batch:assigned', (batch: BatchAssignment) => {
      const amount = batch.totalRevenue.toLocaleString('th-TH');
      void this.notifyDriver(batch.driverId, {
        title: 'มีงานใหม่เข้ามา',
        body: `${batch.orderIds.length} ออเดอร์ · ยอดรวม ${amount} บาท`,
        url: '/driver.html',
        tag: batch.id,
        data: { batchId: batch.id }
      }).catch((error) => {
        logger.warn('push_notify_failed', {
          driverId: batch.driverId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    });
  }
}

export function createPushNotifier(
  store: DispatchStore,
  config: VapidConfig
): PushNotifier {
  let publicKey = config.vapidPublicKey;
  let privateKey = config.vapidPrivateKey;
  if (!publicKey || !privateKey) {
    const generated = webpush.generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    logger.warn('push_vapid_ephemeral', {
      message:
        'VAPID keys are generated at startup; set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to keep subscriptions across restarts',
      publicKey
    });
  }
  return new PushNotifier(store, {
    publicKey,
    privateKey,
    subject: config.vapidSubject ?? 'mailto:ops@example.com'
  });
}

function createWebPushSender(options: PushNotifierOptions): PushSender {
  webpush.setVapidDetails(options.subject, options.publicKey, options.privateKey);
  return async (subscription, payload) => {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys
        },
        JSON.stringify(payload),
        { TTL: 600, urgency: 'high' }
      );
      return 'ok';
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) return 'gone';
      logger.warn('push_send_failed', {
        statusCode,
        error: error instanceof Error ? error.message : String(error)
      });
      return 'error';
    }
  };
}
