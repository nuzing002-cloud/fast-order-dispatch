/**
 * Order and Delivery Type Definitions
 */

export enum OrderStatus {
  PENDING = 'PENDING',
  ASSIGNED = 'ASSIGNED',
  PICKED_UP = 'PICKED_UP',
  IN_DELIVERY = 'IN_DELIVERY',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED'
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED'
}

export enum DriverStatus {
  AVAILABLE = 'AVAILABLE',
  BUSY = 'BUSY',
  ON_BREAK = 'ON_BREAK',
  OFFLINE = 'OFFLINE'
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  address: string;
  latitude: number;
  longitude: number;
  email?: string;
}

export interface Restaurant {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  phone: string;
  preparationTime: number; // in minutes
}

export interface Order {
  id: string;
  orderId: string;
  restaurant: Restaurant;
  customer: Customer;
  items: OrderItem[];
  /** Final amount charged to the customer, including deliveryFee. */
  totalAmount: number;
  deliveryFee: number;
  /** Sum of items before the delivery fee. */
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  /** Drivers who declined this order; dispatch will not offer it to them again. */
  declinedDriverIds?: string[];
  /** Present while the order is waiting in the dispatch queue. */
  queuedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  assignedDriverId?: string;
  assignedAt?: Date;
  pickedUpAt?: Date;
  deliveredAt?: Date;
  estimatedDeliveryTime?: Date;
  notes?: string;
}

export interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
  specialInstructions?: string;
}

export interface Driver {
  id: string;
  name: string;
  phone: string;
  vehicle: string;
  licensePlate: string;
  status: DriverStatus;
  currentLatitude: number;
  currentLongitude: number;
  assignedOrders: string[]; // Order IDs
  totalDeliveries: number;
  rating: number;
  isAvailable: boolean;
  /** When false the driver keeps finishing current work but receives no new batches. */
  acceptsNewOrders?: boolean;
  maxOrdersPerBatch: number;
  lastLocationUpdate?: Date;
}

export interface BatchAssignment {
  id: string;
  driverId: string;
  orderIds: string[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  totalRevenue: number;
  deliverySequence: string[]; // Ordered list of order IDs
  totalDistanceKm?: number;
  totalPreparationMinutes?: number;
  estimatedDurationMinutes?: number;
}

export interface PaymentTransaction {
  id: string;
  orderId: string;
  amount: number;
  method: string;
  kind?: 'charge' | 'refund';
  status: PaymentStatus;
  transactionId?: string;
  /** Payment provider that produced this transaction (mock, http, stripe). */
  provider?: string;
  /** Identifier assigned by the payment provider. */
  providerTransactionId?: string;
  /** Provider transaction this refund refers to. */
  sourceTransactionId?: string;
  createdAt: Date;
  processedAt?: Date;
  notes?: string;
}

export type EarningStatus = 'PENDING' | 'PAID';

export interface DriverEarning {
  id: string;
  driverId: string;
  orderId: string;
  amount: number;
  currency: string;
  status: EarningStatus;
  createdAt: Date;
  paidAt?: Date;
  payoutId?: string;
}

export interface Payout {
  id: string;
  driverId: string;
  amount: number;
  currency: string;
  status: 'PAID';
  method: string;
  reference?: string;
  note?: string;
  earningIds: string[];
  createdAt: Date;
  paidAt: Date;
}

export interface DriverEarningsSummary {
  driverId: string;
  currency: string;
  pendingAmount: number;
  paidAmount: number;
  totalAmount: number;
  earnings: DriverEarning[];
  payouts: Payout[];
}

export interface PushSubscriptionRecord {
  endpoint: string;
  driverId: string;
  keys: { p256dh: string; auth: string };
  createdAt: Date;
}

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  actor: string;
  role: string;
  ip?: string;
  action: string;
  entityType: 'order' | 'payment' | 'driver' | 'batch' | 'system';
  entityId: string;
  details?: Record<string, unknown>;
}

export interface SystemMetrics {
  totalOrdersProcessed: number;
  totalBatchesCreated: number;
  averageProcessingTime: number;
  averageDeliveryTime: number;
  successRate: number;
  totalRevenue: number;
  activeDrivers: number;
  pendingOrders: number;
  timestamp: Date;
}

export interface CreateOrderInput {
  orderId?: string;
  restaurant: Restaurant;
  customer: Customer;
  items: OrderItem[];
  totalAmount: number;
  deliveryFee: number;
  notes?: string;
}

export interface CreateDriverInput {
  name: string;
  phone: string;
  vehicle: string;
  licensePlate: string;
  currentLatitude: number;
  currentLongitude: number;
  maxOrdersPerBatch?: number;
  rating?: number;
}
