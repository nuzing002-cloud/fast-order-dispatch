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
    '/integrations/shopee-driver/links': {
      get: {
        summary: 'List supported Shopee Driver deep links',
        description:
          'Navigation-only handoff links for the installed Shopee Food Driver Android app. These links do not exchange order data or authenticate against private Shopee APIs.',
        responses: { '200': { description: 'Supported deep links' } }
      }
    },
    '/integrations/shopee-driver/deep-link': {
      get: {
        summary: 'Get one supported Shopee Driver deep link',
        description: 'Use the returned URL with Android Linking.openURL or an HTML anchor.',
        parameters: [
          {
            name: 'destination',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['home', 'notification', 'order-detail', 'transactions'],
              default: 'home'
            }
          }
        ],
        responses: {
          '200': { description: 'Deep link' },
          '400': { description: 'Unsupported destination' }
        }
      }
    },
    '/webhooks/shopee-bridge': {
      post: {
        summary: 'Receive events from the local Shopee bridge',
        description:
          'Read-only event ingestion for the bridge on port 4020. Without SHOPEE_BRIDGE_WEBHOOK_SECRET the endpoint accepts loopback sources only. With a secret, send x-shopee-bridge-signature: sha256=<hex HMAC of the raw body>. This endpoint never accepts or opens Shopee jobs.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { type: 'object', additionalProperties: true } }
          }
        },
        responses: {
          '200': { description: 'Event received (duplicates are reported)' },
          '400': { description: 'Invalid event payload' },
          '401': { description: 'Invalid HMAC signature' },
          '403': { description: 'Non-loopback source without a signature' },
          '503': { description: 'Shopee bridge sync is not configured' }
        }
      }
    },
    '/integrations/shopee-bridge/status': {
      get: {
        summary: 'Read-only Shopee bridge status',
        description:
          'Cached health, events, orders, and screenshot metadata for port 4020. The response includes dataFreshness so stale cached state is distinguishable from live state. This API exposes no open/accept commands.',
        responses: { '200': { description: 'Bridge status' } }
      }
    },
    '/integrations/shopee-bridge/sync': {
      post: {
        summary: 'Refresh the Shopee bridge snapshot',
        description:
          'Pulls health, events, orders, and the latest area screenshot from port 4020. Requires admin or operator when auth is enabled.',
        responses: {
          '200': { description: 'Refreshed status' },
          '403': { description: 'Requires admin or operator role' },
          '409': { description: 'Shopee bridge sync is not configured' }
        }
      }
    },
    '/integrations/shopee-bridge/screenshot': {
      get: {
        summary: 'Latest Shopee area screenshot',
        description: 'Returns the cached image/png from the bridge area check. Read-only.',
        responses: {
          '200': { description: 'PNG image', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
          '404': { description: 'No screenshot captured yet' },
          '409': { description: 'Shopee bridge sync is not configured' }
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
    '/drivers/{id}/earnings': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        summary: 'Driver earnings and payout history',
        responses: {
          '200': { description: 'Earnings summary' },
          '404': { description: 'Driver not found' }
        }
      }
    },
    '/payouts': {
      get: {
        summary: 'List driver payouts',
        parameters: [
          { name: 'driverId', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }
        ],
        responses: {
          '200': { description: 'Payouts' },
          '403': { description: 'Requires admin role' }
        }
      },
      post: {
        summary: 'Pay out all pending earnings for a driver (admin)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['driverId'],
                properties: {
                  driverId: { type: 'string' },
                  method: { type: 'string' },
                  reference: { type: 'string' },
                  note: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          '201': { description: 'Payout recorded' },
          '404': { description: 'Driver not found' },
          '409': { description: 'No pending earnings' }
        }
      }
    },
    '/push/public-key': {
      get: {
        summary: 'VAPID public key for browser push subscriptions',
        security: [],
        responses: {
          '200': { description: 'Public key' },
          '503': { description: 'Push notifications are not configured' }
        }
      }
    },
    '/push/subscribe': {
      post: {
        summary: 'Register a browser push subscription for a driver',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['driverId', 'subscription'],
                properties: {
                  driverId: { type: 'string' },
                  subscription: { $ref: '#/components/schemas/PushSubscription' }
                }
              }
            }
          }
        },
        responses: {
          '201': { description: 'Subscribed' },
          '400': { description: 'Validation error' },
          '404': { description: 'Driver not found' }
        }
      }
    },
    '/push/unsubscribe': {
      post: {
        summary: 'Remove a browser push subscription',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['endpoint'],
                properties: { endpoint: { type: 'string' } }
              }
            }
          }
        },
        responses: { '200': { description: 'Subscription removed (if it existed)' } }
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
                      'READY',
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
    '/orders/{id}/decline': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      post: {
        summary: 'Decline an assigned order (driver) and return it to the queue',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { driverId: { type: 'string' } }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Order returned to the READY dispatch queue' },
          '404': { description: 'Not found' },
          '409': { description: 'Order is not ASSIGNED' }
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
    '/metrics/prometheus': {
      get: {
        summary: 'Dispatch and process metrics in Prometheus text format',
        responses: {
          '200': {
            description: 'Prometheus exposition',
            content: { 'text/plain': { schema: { type: 'string' } } }
          }
        }
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
      PushSubscription: {
        type: 'object',
        required: ['endpoint', 'keys'],
        properties: {
          endpoint: { type: 'string' },
          expirationTime: { type: 'number', nullable: true },
          keys: {
            type: 'object',
            required: ['p256dh', 'auth'],
            properties: {
              p256dh: { type: 'string' },
              auth: { type: 'string' }
            }
          }
        }
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
