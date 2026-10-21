import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { ApiKeyEntry, authenticate, normalizeApiKeyInput } from './auth';
import { logger } from './logger';
import { BatchProcessingService } from './services/BatchProcessingService';

export interface RealtimeOptions {
  apiKey?: string;
  apiKeys?: ApiKeyEntry[] | string;
  corsOrigins?: string[];
  redisUrl?: string | null;
}

export async function attachRealtime(
  httpServer: HttpServer,
  service: BatchProcessingService,
  options: RealtimeOptions = {}
): Promise<SocketServer> {
  const io = new SocketServer(httpServer, {
    cors: { origin: options.corsOrigins ?? ['*'] }
  });

  const entries = normalizeApiKeyInput(options.apiKeys ?? options.apiKey);
  if (entries.length > 0) {
    io.use((socket, next) => {
      const auth = socket.handshake.auth as { token?: unknown } | undefined;
      const headerToken = socket.handshake.headers['x-api-key'];
      const token =
        typeof auth?.token === 'string'
          ? auth.token
          : typeof headerToken === 'string'
            ? headerToken
            : undefined;
      if (token && authenticate(entries, token)) {
        next();
        return;
      }
      next(new Error('Unauthorized'));
    });
  }

  io.on('connection', (socket) => {
    void (async () => {
      try {
        socket.emit('state', {
          queueSize: await service.getQueueSize(),
          drivers: await service.getDrivers()
        });
      } catch (error) {
        logger.warn('realtime_state_failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();
  });

  service.on('order:created', (order) => io.emit('order:created', order));
  service.on('order:queued', (order) => io.emit('order:queued', order));
  service.on('order:status', (payload) => io.emit('order:status', payload));
  service.on('payment:updated', (payload) => io.emit('payment:updated', payload));
  service.on('payment:recorded', (payment) => io.emit('payment:recorded', payment));
  service.on('batch:assigned', (batch) => io.emit('batch:assigned', batch));
  service.on('batch:completed', (batch) => io.emit('batch:completed', batch));
  service.on('driver:updated', (driver) => io.emit('driver:updated', driver));

  const redisUrl = options.redisUrl === undefined ? process.env.REDIS_URL : options.redisUrl;
  if (redisUrl) {
    const connected = await connectRedisAdapter(io, redisUrl);
    if (!connected && process.env.NODE_ENV === 'production') {
      throw new Error('Failed to connect the Redis adapter');
    }
  }

  return io;
}

export async function connectRedisAdapter(io: SocketServer, url: string): Promise<boolean> {
  let pubClient: ReturnType<typeof import('redis').createClient> | undefined;
  let subClient: ReturnType<typeof import('redis').createClient> | undefined;
  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    const { createClient } = require('redis');
    const publisher = createClient({
      url,
      socket: { reconnectStrategy: (retries: number) => Math.min(retries * 200, 2_000) }
    });
    const subscriber = publisher.duplicate();
    const onRedisError = (error: Error): void => {
      logger.warn('redis_adapter_error', {
        redis: redisHost(url),
        error: error.message
      });
    };
    publisher.on('error', onRedisError);
    subscriber.on('error', onRedisError);
    pubClient = publisher;
    subClient = subscriber;
    await Promise.race([
      Promise.all([publisher.connect(), subscriber.connect()]),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Redis connection timed out')),
          5_000
        );
        timer.unref?.();
      })
    ]);
    io.adapter(createAdapter(publisher, subscriber));
    io.httpServer?.once('close', () => {
      for (const client of [publisher, subscriber]) {
        void client.quit().catch(() => client.disconnect().catch(() => undefined));
      }
    });
    logger.info('redis_adapter_enabled', { redis: redisHost(url) });
    return true;
  } catch (error) {
    for (const client of [pubClient, subClient]) {
      if (!client) continue;
      try {
        await client.disconnect();
      } catch {
        // ignore cleanup errors
      }
    }
    logger.error('redis_adapter_disabled', {
      redis: redisHost(url),
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

function redisHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '6379'}`;
  } catch {
    return 'configured';
  }
}
