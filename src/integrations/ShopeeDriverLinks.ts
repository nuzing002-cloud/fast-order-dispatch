import { ValidationError } from '../errors';

export type ShopeeDriverDestination =
  | 'home'
  | 'notification'
  | 'order-detail'
  | 'transactions';

export interface ShopeeDriverLink {
  destination: ShopeeDriverDestination;
  url: string;
  targetPackage: 'com.shopee.foody.driver.th';
  capability: 'navigation-only';
}

const TARGET_PACKAGE = 'com.shopee.foody.driver.th' as const;

const DESTINATION_URLS: Record<ShopeeDriverDestination, string> = {
  home: 'foody://driver/n/driver/home',
  notification: 'foody://driver/n/driver/notification',
  'order-detail': 'foody://driver/rn/@shopee-rn/main/ORDER_DETAIL',
  transactions: 'foody://driver/rn/@shopee-rn/main/TRANSACTIONS'
};

export function parseShopeeDriverDestination(value: unknown): ShopeeDriverDestination {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'home';
  }

  const destination = value.trim() as ShopeeDriverDestination;
  if (!Object.prototype.hasOwnProperty.call(DESTINATION_URLS, destination)) {
    throw new ValidationError(
      `destination must be one of: ${Object.keys(DESTINATION_URLS).join(', ')}`
    );
  }
  return destination;
}

export function buildShopeeDriverLink(destination: ShopeeDriverDestination): ShopeeDriverLink {
  return {
    destination,
    url: DESTINATION_URLS[destination],
    targetPackage: TARGET_PACKAGE,
    capability: 'navigation-only'
  };
}

export function listShopeeDriverLinks(): ShopeeDriverLink[] {
  return (Object.keys(DESTINATION_URLS) as ShopeeDriverDestination[]).map(
    buildShopeeDriverLink
  );
}