import { createHmac, timingSafeEqual } from 'crypto';
import { toMinorUnits } from '../utils/Money';
import { GatewayResult, PaymentGateway } from './PaymentService';
import { Order, PaymentTransaction } from '../types/order';

export interface HttpPaymentGatewayOptions {
  url: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Provider-agnostic HTTP gateway. The configured endpoint receives the charge
 * or refund and must answer with `{ success: boolean, transactionId?: string }`
 * (or `{ status: 'succeeded' }`).
 */
export class HttpPaymentGateway implements PaymentGateway {
  constructor(private readonly options: HttpPaymentGatewayOptions) {}

  charge(order: Order, transaction: PaymentTransaction): Promise<GatewayResult> {
    return this.call('charge', order, transaction);
  }

  refund(order: Order, transaction: PaymentTransaction): Promise<GatewayResult> {
    return this.call('refund', order, transaction);
  }

  private async call(
    kind: 'charge' | 'refund',
    order: Order,
    transaction: PaymentTransaction
  ): Promise<GatewayResult> {
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const response = await fetch(this.options.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {})
      },
      body: JSON.stringify({
        kind,
        orderId: order.id,
        transactionId: transaction.id,
        amount: Math.abs(transaction.amount),
        amountMinor: toMinorUnits(Math.abs(transaction.amount)),
        currency: 'THB',
        method: transaction.method,
        sourceTransactionId: transaction.sourceTransactionId ?? null
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    const text = await response.text();
    const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const message =
        typeof body.error === 'string'
          ? body.error
          : typeof body.message === 'string'
            ? body.message
            : `Payment gateway returned HTTP ${response.status}`;
      throw new Error(message);
    }

    const success =
      body.success === true
        || body.status === 'succeeded'
        || body.status === 'COMPLETED'
        || body.status === 'completed';
    const providerTransactionId =
      typeof body.transactionId === 'string'
        ? body.transactionId
        : typeof body.id === 'string'
          ? body.id
          : undefined;

    return {
      success,
      providerTransactionId,
      notes: typeof body.status === 'string' ? body.status : undefined
    };
  }
}

export interface StripePaymentGatewayOptions {
  secretKey: string;
  apiBase?: string;
  timeoutMs?: number;
}

/**
 * Minimal Stripe PaymentIntent adapter. Uses the `method` value as a Stripe
 * payment method (for example `pm_card_visa` in test mode).
 */
export class StripePaymentGateway implements PaymentGateway {
  private readonly apiBase: string;

  constructor(private readonly options: StripePaymentGatewayOptions) {
    this.apiBase = (options.apiBase ?? 'https://api.stripe.com').replace(/\/+$/, '');
  }

  async charge(order: Order, transaction: PaymentTransaction): Promise<GatewayResult> {
    const body = new URLSearchParams({
      amount: String(toMinorUnits(order.totalAmount)),
      currency: 'thb',
      confirm: 'true',
      payment_method: transaction.method,
      'automatic_payment_methods[allow_redirects]': 'never',
      'metadata[orderId]': order.id,
      'metadata[transactionId]': transaction.id
    });
    const response = await this.request('/v1/payment_intents', body);
    const status = typeof response.status === 'string' ? response.status : '';
    return {
      success: status === 'succeeded',
      providerTransactionId: typeof response.id === 'string' ? response.id : undefined,
      notes: status || undefined
    };
  }

  async refund(_order: Order, transaction: PaymentTransaction): Promise<GatewayResult> {
    if (!transaction.sourceTransactionId) {
      throw new Error('Stripe refund requires the original payment intent id');
    }
    const body = new URLSearchParams({
      payment_intent: transaction.sourceTransactionId,
      amount: String(toMinorUnits(Math.abs(transaction.amount)))
    });
    const response = await this.request('/v1/refunds', body);
    const status = typeof response.status === 'string' ? response.status : '';
    return {
      success: status === 'succeeded' || status === 'pending',
      providerTransactionId: typeof response.id === 'string' ? response.id : undefined,
      notes: status || undefined
    };
  }

  private async request(path: string, body: URLSearchParams): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString(),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000)
    });
    const text = await response.text();
    const payload = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const error = payload.error as Record<string, unknown> | undefined;
      const message =
        typeof error?.message === 'string'
          ? error.message
          : `Stripe returned HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }
}

function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyStripeSignature(
  payload: Buffer | string,
  header: string | undefined,
  secret: string,
  toleranceSeconds = 300
): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',');
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split('=', 2);
    if (key === 't') timestamp = Number(value);
    if (key === 'v1' && value) signatures.push(value);
  }

  if (!timestamp || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const payloadText = typeof payload === 'string' ? payload : payload.toString('utf8');
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${payloadText}`)
    .digest('hex');

  return signatures.some((signature) => safeEqualHex(expected, signature));
}

export function verifyHmacSignature(
  payload: Buffer | string,
  header: string | undefined,
  secret: string
): boolean {
  if (!header || !secret) return false;
  const provided = header.startsWith('sha256=') ? header.slice(7) : header;
  const payloadText = typeof payload === 'string' ? payload : payload.toString('utf8');
  const expected = createHmac('sha256', secret).update(payloadText).digest('hex');
  return safeEqualHex(expected, provided.trim());
}
