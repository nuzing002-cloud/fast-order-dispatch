import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { logger } from './logger';
import { BatchProcessingService } from './services/BatchProcessingService';

export interface RealtimeOptions {
  apiKey?: string;
  redisUrl?: string | null;
}

export function attachRealtime(
  httpServer: HttpServer,
  service: BatchProcessingService,
  options: RealtimeOptions = {}
): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN ?? '*' }
  });

  if (options.apiKey) {
    io.use((socket, next) => {
      const auth = socket.handshake.auth as { token?: unknown } | undefined;
      const headerToken = socket.handshake.headers['x-api-key'];
      if (auth?.token === options.apiKey || headerToken === options.apiKey) {
        next();
        return;
      }
      next(new Error('Unauthorized'));
    });
  }

  io.on('connection', (socket) => {
    socket.emit('state', {
      queueSize: service.getQueueSize(),
      drivers: service.getDrivers()
    });
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
    void connectRedisAdapter(io, redisUrl);
  }

  return io;
}

export async function connectRedisAdapter(io: SocketServer, url: string): Promise<boolean> {
  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    const { createClient } = require('redis');
    const pubClient = createClient({
      url,
      socket: { reconnectStrategy: () => false }
    });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    logger.info('redis_adapter_enabled', { url });
    return true;
  } catch (error) {
    logger.error('redis_adapter_disabled', {
      url,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}
