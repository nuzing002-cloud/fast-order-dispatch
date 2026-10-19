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
  totalAmount: number;
  deliveryFee: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
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
  estimatedDurationMinutes?: number;
}

export interface PaymentTransaction {
  id: string;
  orderId: string;
  amount: number;
  method: string;
  status: PaymentStatus;
  transactionId?: string;
  createdAt: Date;
  processedAt?: Date;
  notes?: string;
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
