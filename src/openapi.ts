export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'fast-order-dispatch',
    version: '1.0.0',
    description:
      'Order dispatch API with batch routing, payments, lifecycle tracking, metrics, and realtime events.'
  },
  servers: [{ url: '/', description: 'Current host' }],
  security: [{ ApiKeyAuth: [] }],
  paths: {
    '/health': {
      get: {
        summary: 'Liveness information',
        security: [],
        responses: { '200': { description: 'Service status' } }
      }
    },
    '/ready': {
      get: {
        summary: 'Readiness probe',
        security: [],
        responses: {
          '200': { description: 'Ready' },
          '503': { description: 'Storage unavailable' }
        }
      }
    },
    '/drivers': {
      get: {
        summary: 'List drivers',
        responses: { '200': { description: 'Drivers' } }
      },
      post: {
        summary: 'Register a driver',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverInput' } } }
        },
        responses: {
          '201': { description: 'Created' },
          '400': { description: 'Validation error' },
          '409': { description: 'Driver already exists' }
        }
      }
    },
    '/drivers/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        summary: 'Fetch a driver',
        responses: {
          '200': { description: 'Driver' },
          '404': { description: 'Not found' }
        }
      },
      patch: {
        summary: 'Update driver location, availability, capacity, or rating',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverPatch' } } }
        },
        responses: {
          '200': { description: 'Updated driver' },
          '400': { description: 'Validation error' },
          '404': { description: 'Not found' },
          '409': { description: 'Driver has active orders' }
        }
      }
    },
    '/orders': {
      get: {
        summary: 'List orders',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }
        ],
        responses: { '200': { description: 'Paginated orders' } }
      },
      post: {
        summary: 'Create an order, charge it, and attempt dispatch',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description: 'Replays the stored response for the same key and body (24h by default).',
            schema: { type: 'string', maxLength: 255 }
          }
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderInput' } } }
        },
        responses: {
          '201': { description: 'Created and charged' },
          '400': { description: 'Validation error' },
          '402': { description: 'Payment failed; order stored but not queued' },
          '409': { description: 'Idempotency-Key reused with a different request' }
        }
      }
    },
    '/orders/pending': {
      get: {
        summary: 'List queued orders',
        responses: { '200': { description: 'Pending orders' } }
      }
    },
    '/orders/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        summary: 'Fetch an order',
        responses: {
          '200': { description: 'Order' },
          '404': { description: 'Not found' }
        }
      }
    },
    '/orders/{id}/status': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      patch: {
        summary: 'Advance the order lifecycle',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: {
                  status: {
                    type: 'string',
                    enum: [
                      'PENDING',
                      'ASSIGNED',
                      'PICKED_UP',
                      'IN_DELIVERY',
                      'DELIVERED',
                      'CANCELLED',
                      'FAILED'
                    ]
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Updated order' },
          '400': { description: 'Unknown status' },
          '404': { description: 'Not found' },
          '409': { description: 'Invalid transition' }
        }
      }
    },
    '/orders/{id}/pay': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      post: {
        summary: 'Retry payment',
        responses: {
          '200': { description: 'Payment completed' },
          '402': { description: 'Payment failed' },
          '404': { description: 'Not found' },
          '409': { description: 'Already paid' }
        }
      }
    },
    '/orders/{id}/refund': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      post: {
        summary: 'Refund a completed payment',
        responses: {
          '200': { description: 'Refund completed' },
          '402': { description: 'Refund failed' },
          '404': { description: 'Not found' },
          '409': { description: 'No completed payment' }
        }
      }
    },
    '/orders/{id}/payments': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        summary: 'List payment transactions for an order',
        responses: {
          '200': { description: 'Transactions' },
          '404': { description: 'Not found' }
        }
      }
    },
    '/batches': {
      get: {
        summary: 'List batch assignments',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }
        ],
        responses: { '200': { description: 'Paginated batches' } }
      }
    },
    '/metrics': {
      get: {
        summary: 'Dispatch metrics',
        responses: { '200': { description: 'Metrics snapshot' } }
      }
    },
    '/audit': {
      get: {
        summary: 'List audit entries (admin only)',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }
        ],
        responses: {
          '200': { description: 'Paginated audit entries' },
          '403': { description: 'Admin role required' }
        }
      }
    },
    '/webhooks/payments': {
      post: {
        summary: 'Payment provider webhook (signature verified, no API key required)',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: {
          '200': { description: 'Webhook accepted' },
          '400': { description: 'Invalid signature or payload' },
          '404': { description: 'Webhook disabled (mock provider)' },
          '503': { description: 'Webhook secret not configured' }
        }
      }
    },
    '/dispatch/process': {
      post: {
        summary: 'Run one dispatch cycle',
        responses: { '200': { description: 'Batch or null when nothing was dispatched' } }
      }
    }
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key'
      }
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } }
      },
      Restaurant: {
        type: 'object',
        required: ['id', 'name', 'address', 'latitude', 'longitude', 'phone', 'preparationTime'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          address: { type: 'string' },
          latitude: { type: 'number' },
          longitude: { type: 'number' },
          phone: { type: 'string' },
          preparationTime: { type: 'number' }
        }
      },
      Customer: {
        type: 'object',
        required: ['id', 'name', 'phone', 'address', 'latitude', 'longitude'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          phone: { type: 'string' },
          address: { type: 'string' },
          latitude: { type: 'number' },
          longitude: { type: 'number' },
          email: { type: 'string' }
        }
      },
      OrderItem: {
        type: 'object',
        required: ['id', 'name', 'quantity', 'price'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          quantity: { type: 'number' },
          price: { type: 'number' },
          specialInstructions: { type: 'string' }
        }
      },
      OrderInput: {
        type: 'object',
        required: ['restaurant', 'customer', 'items', 'totalAmount', 'deliveryFee'],
        properties: {
          id: { type: 'string' },
          orderId: { type: 'string' },
          restaurant: { $ref: '#/components/schemas/Restaurant' },
          customer: { $ref: '#/components/schemas/Customer' },
          items: { type: 'array', items: { $ref: '#/components/schemas/OrderItem' } },
          totalAmount: { type: 'number' },
          deliveryFee: { type: 'number' },
          paymentMethod: { type: 'string' },
          notes: { type: 'string' }
        }
      },
      AuditEntry: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
          actor: { type: 'string' },
          role: { type: 'string' },
          ip: { type: 'string' },
          action: { type: 'string' },
          entityType: { type: 'string', enum: ['order', 'payment', 'driver', 'batch', 'system'] },
          entityId: { type: 'string' },
          details: { type: 'object' }
        }
      },
      Order: {
        allOf: [
          { $ref: '#/components/schemas/OrderInput' },
          {
            type: 'object',
            properties: {
              status: { type: 'string' },
              paymentStatus: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
              assignedDriverId: { type: 'string' },
              assignedAt: { type: 'string', format: 'date-time' },
              pickedUpAt: { type: 'string', format: 'date-time' },
              deliveredAt: { type: 'string', format: 'date-time' },
              estimatedDeliveryTime: { type: 'string', format: 'date-time' }
            }
          }
        ]
      },
      DriverInput: {
        type: 'object',
        required: ['id', 'name', 'phone', 'vehicle', 'licensePlate', 'currentLatitude', 'currentLongitude'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          phone: { type: 'string' },
          vehicle: { type: 'string' },
          licensePlate: { type: 'string' },
          currentLatitude: { type: 'number' },
          currentLongitude: { type: 'number' },
          maxOrdersPerBatch: { type: 'integer', minimum: 1 },
          rating: { type: 'number', minimum: 0, maximum: 5 }
        }
      },
      DriverPatch: {
        type: 'object',
        properties: {
          currentLatitude: { type: 'number' },
          currentLongitude: { type: 'number' },
          status: { type: 'string', enum: ['AVAILABLE', 'ON_BREAK', 'OFFLINE'] },
          isAvailable: { type: 'boolean' },
          maxOrdersPerBatch: { type: 'integer', minimum: 1 },
          rating: { type: 'number', minimum: 0, maximum: 5 }
        }
      },
      Batch: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          driverId: { type: 'string' },
          orderIds: { type: 'array', items: { type: 'string' } },
          deliverySequence: { type: 'array', items: { type: 'string' } },
          totalRevenue: { type: 'number' },
          totalDistanceKm: { type: 'number' },
          totalPreparationMinutes: { type: 'number' },
          estimatedDurationMinutes: { type: 'number' },
          createdAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time' }
        }
      },
      PaymentTransaction: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          orderId: { type: 'string' },
          amount: { type: 'number' },
          method: { type: 'string' },
          kind: { type: 'string', enum: ['charge', 'refund'] },
          status: { type: 'string' },
          provider: { type: 'string' },
          providerTransactionId: { type: 'string' },
          sourceTransactionId: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          processedAt: { type: 'string', format: 'date-time' },
          notes: { type: 'string' }
        }
      },
      Metrics: {
        type: 'object',
        properties: {
          totalOrdersProcessed: { type: 'integer' },
          totalBatchesCreated: { type: 'integer' },
          averageProcessingTime: { type: 'number' },
          averageDeliveryTime: { type: 'number' },
          successRate: { type: 'number' },
          totalRevenue: { type: 'number' },
          activeDrivers: { type: 'integer' },
          pendingOrders: { type: 'integer' },
          timestamp: { type: 'string', format: 'date-time' }
        }
      }
    }
  }
};
