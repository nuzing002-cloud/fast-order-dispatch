import { createServer, IncomingMessage } from 'http';
import { AddressInfo } from 'net';
import {
  HttpPaymentGateway,
  StripePaymentGateway,
  verifyHmacSignature
} from '../src/services/PaymentGateways';
import { Order, PaymentStatus, PaymentTransaction } from '../src/types/order';
import { makeOrder } from './helpers';

interface TestResponse {
  status?: number;
  body?: string;
}

async function withServer(
  handler: (request: IncomingMessage, body: string) => TestResponse,
  run: (url: string) => Promise<void>
): Promise<void> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const result = handler(request, Buffer.concat(chunks).toString('utf8'));
      response.statusCode = result.status ?? 200;
      response.setHeader('content-type', 'application/json');
      response.end(result.body ?? '');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

function makeTransaction(order: Order): PaymentTransaction {
  return {
    id: 'tx-1',
    orderId: order.id,
    amount: 100,
    method: 'card',
    status: PaymentStatus.PENDING,
    sourceTransactionId: 'pi_source',
    createdAt: new Date()
  };
}

test('HttpPaymentGateway sends charge details and parses the response', async () => {
  const order = makeOrder('http-charge');
  const transaction = makeTransaction(order);
  let receivedBody: Record<string, unknown> = {};
  let authorization: string | undefined;

  await withServer(
    (request, body) => {
      authorization = request.headers.authorization;
      receivedBody = JSON.parse(body) as Record<string, unknown>;
      return { body: JSON.stringify({ success: true, transactionId: 'gw-1' }) };
    },
    async (url) => {
      const gateway = new HttpPaymentGateway({ url, apiKey: 'gateway-secret' });
      const result = await gateway.charge(order, transaction);
      expect(result).toEqual({
        success: true,
        providerTransactionId: 'gw-1',
        notes: undefined
      });
    }
  );

  expect(authorization).toBe('Bearer gateway-secret');
  expect(receivedBody).toMatchObject({
    kind: 'charge',
    orderId: order.id,
    transactionId: 'tx-1',
    amountMinor: 10000,
    currency: 'THB',
    sourceTransactionId: 'pi_source'
  });
});

test('HttpPaymentGateway accepts provider status aliases', async () => {
  const order = makeOrder('http-status');
  const transaction = makeTransaction(order);
  const statuses = ['succeeded', 'COMPLETED', 'completed'];

  await withServer(
    (_request, _body) => {
      const status = statuses.shift() ?? 'failed';
      return { body: JSON.stringify({ status }) };
    },
    async (url) => {
      const gateway = new HttpPaymentGateway({ url });
      for (const status of ['succeeded', 'COMPLETED', 'completed']) {
        const result = await gateway.charge(order, transaction);
        expect(result).toEqual({ success: true, providerTransactionId: undefined, notes: status });
      }

      const failed = await gateway.refund(order, transaction);
      expect(failed).toEqual({ success: false, providerTransactionId: undefined, notes: 'failed' });
    }
  );

  expect(statuses).toHaveLength(0);
});

test('HttpPaymentGateway uses the provider id field', async () => {
  const order = makeOrder('http-id');
  await withServer(
    () => ({ body: JSON.stringify({ id: 'provider-id' }) }),
    async (url) => {
      const gateway = new HttpPaymentGateway({ url });
      await expect(gateway.charge(order, makeTransaction(order))).resolves.toEqual({
        success: false,
        providerTransactionId: 'provider-id',
        notes: undefined
      });
    }
  );
});

test.each([
  [402, { error: 'declined' }, 'declined'],
  [400, { message: 'bad request' }, 'bad request'],
  [500, undefined, 'Payment gateway returned HTTP 500']
])('HttpPaymentGateway surfaces HTTP %i errors', async (status, body, message) => {
  const order = makeOrder(`http-error-${status}`);
  await withServer(
    () => ({ status, body: body ? JSON.stringify(body) : '' }),
    async (url) => {
      const gateway = new HttpPaymentGateway({ url });
      await expect(gateway.charge(order, makeTransaction(order))).rejects.toThrow(message);
    }
  );
});

test('StripePaymentGateway creates a PaymentIntent', async () => {
  const order = makeOrder('stripe-charge');
  const transaction = makeTransaction(order);
  let path = '';
  let form = '';

  await withServer(
    (request, body) => {
      path = request.url ?? '';
      form = body;
      return { body: JSON.stringify({ id: 'pi_123', status: 'succeeded' }) };
    },
    async (url) => {
      const gateway = new StripePaymentGateway({ secretKey: 'sk_test', apiBase: `${url}/` });
      const result = await gateway.charge(order, transaction);
      expect(result).toEqual({
        success: true,
        providerTransactionId: 'pi_123',
        notes: 'succeeded'
      });
    }
  );

  expect(path).toBe('/v1/payment_intents');
  expect(form).toContain('payment_method=card');
  expect(form).toContain('metadata%5BorderId%5D=stripe-charge');
});

test('StripePaymentGateway refunds and validates the source transaction', async () => {
  const order = makeOrder('stripe-refund');
  const transaction = makeTransaction(order);
  let path = '';

  await withServer(
    (request) => {
      path = request.url ?? '';
      return { body: JSON.stringify({ id: 're_123', status: 'pending' }) };
    },
    async (url) => {
      const gateway = new StripePaymentGateway({ secretKey: 'sk_test', apiBase: url });
      const result = await gateway.refund(order, transaction);
      expect(result).toEqual({
        success: true,
        providerTransactionId: 're_123',
        notes: 'pending'
      });
    }
  );

  expect(path).toBe('/v1/refunds');

  const gateway = new StripePaymentGateway({ secretKey: 'sk_test' });
  await expect(
    gateway.refund(order, { ...transaction, sourceTransactionId: undefined })
  ).rejects.toThrow('original payment intent id');
});

test('StripePaymentGateway surfaces provider errors', async () => {
  const order = makeOrder('stripe-error');
  await withServer(
    () => ({ status: 402, body: JSON.stringify({ error: { message: 'card declined' } }) }),
    async (url) => {
      const gateway = new StripePaymentGateway({ secretKey: 'sk_test', apiBase: url });
      await expect(gateway.charge(order, makeTransaction(order))).rejects.toThrow(
        'card declined'
      );
    }
  );
});

test('verifyHmacSignature validates generic webhook signatures', () => {
  const payload = Buffer.from('{"event":"payment"}');
  const secret = 'webhook-secret';
  const signature = require('crypto')
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex') as string;

  expect(verifyHmacSignature(payload, signature, secret)).toBe(true);
  expect(verifyHmacSignature(payload, `sha256=${signature}`, secret)).toBe(true);
  expect(verifyHmacSignature(payload, 'deadbeef', secret)).toBe(false);
  expect(verifyHmacSignature(payload, undefined, secret)).toBe(false);
  expect(verifyHmacSignature(payload, signature, '')).toBe(false);
});
