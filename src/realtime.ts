import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { BatchProcessingService } from './services/BatchProcessingService';

export function attachRealtime(
  httpServer: HttpServer,
  service: BatchProcessingService
): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN ?? '*' }
  });

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
  service.on('batch:assigned', (batch) => io.emit('batch:assigned', batch));
  service.on('batch:completed', (batch) => io.emit('batch:completed', batch));
  service.on('driver:updated', (driver) => io.emit('driver:updated', driver));

  configureRedisAdapter(io);
  return io;
}

function configureRedisAdapter(io: SocketServer): void {
  const url = process.env.REDIS_URL;
  if (!url) return;

  void (async () => {
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
      console.log('[REALTIME] Redis adapter enabled');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[REALTIME] Redis adapter disabled: ${message}`);
    }
  })();
}
