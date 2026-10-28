# Shopee Partner API research for Fast Order Dispatch

**Checked:** 2026-10-25 (Asia/Bangkok)  
**Scope:** Public Shopee Open Platform V2 documentation only. No credentials, private app APIs, cookies, tokens, or reverse-engineering are used.

## Conclusion

Shopee Open Platform documents marketplace shop-order and logistics APIs, plus push/webhook configuration. The public V2 catalog reviewed here does **not** document an API for ShopeeFood / Food Driver offers, driver assignment, or the Food Driver app's live order feed. The marketplace Order API must not be treated as a Food Driver API: its documented order states and shipping workflow concern seller marketplace orders.

**Food Driver integration is BLOCKED pending written confirmation from Shopee** that an authorized API/product exists for the target Thai account and use case, and that the user's app/shop is eligible. Do not attempt to bridge this gap with private app endpoints, session cookies, token extraction, or UI reverse-engineering. The FOD server's Shopee bridge API remains read-only: it does not create dispatch records or expose Shopee write proxies.

## Official authorization model

1. Register an application with Shopee Open Platform and obtain the assigned `partner_id` and `partner_key`; the app must have the needed product/API permissions approved.
2. Use the documented partner/shop authorization flow to have the shop owner authorize the application. Obtain the shop-scoped `shop_id`, `access_token`, and `refresh_token` only through the official flow.
3. Sign API requests using the documented HMAC-SHA256 scheme. Shop-scoped calls include `partner_id`, API path, timestamp, `access_token`, and `shop_id` in the signature input; public partner calls use the documented public-call inputs. The partner key is a secret and must never be sent to a browser or committed.
4. The Open Platform API reference says request timestamps expire after five minutes and access tokens are valid for four hours. Follow the current authorization guide for refresh-token handling and any migration requirements; the public page may change.
5. Use the correct region/API host and permissions shown for the registered application. Do not assume the generic host or a marketplace permission applies to ShopeeFood.

## Configuration names for a future authorized connector

Names only; no values are supplied. Keep secret values in the private runtime environment, never in source control, examples, logs, or browser configuration.

| Environment variable | Purpose | Secret? |
| --- | --- | --- |
| `SHOPEE_PARTNER_ID` | Registered Open Platform application ID | No |
| `SHOPEE_PARTNER_KEY` | HMAC signing key | **Yes** |
| `SHOPEE_REDIRECT_URL` | Registered OAuth redirect/callback URL | No |
| `SHOPEE_SHOP_ID` | Shop authorized to the app | No |
| `SHOPEE_ACCESS_TOKEN` | Shop-scoped API token | **Yes** |
| `SHOPEE_REFRESH_TOKEN` | Token used only in the official refresh flow | **Yes** |
| `SHOPEE_API_BASE_URL` | Region-appropriate official API host | No |

These are proposed names for a future FOD integration, not existing FOD configuration. Do not add them to `.env.example` or enable a connector until Shopee confirms the Food Driver product/API and required scopes.

## Documented endpoint families and FOD fit

| Official API | Documented use | Potential FOD use | Important boundary |
| --- | --- | --- | --- |
| `v2.order.get_order_list` (`/api/v2/order/get_order_list`) | Search a shop's marketplace orders by a time range, with cursor pagination and optional status filter | Candidate source for an explicitly authorized marketplace-order import | Time range is limited to 15 days per request; `page_size` is 1–100. Status values include `UNPAID`, `READY_TO_SHIP`, `PROCESSED`, `SHIPPED`, `COMPLETED`, `IN_CANCEL`, and `CANCELLED`, not Food Driver offer states. |
| `v2.order.get_order_detail` (`/api/v2/order/get_order_detail`) | Retrieve details for supplied marketplace order numbers | Enrich a marketplace order after explicit shop authorization | `order_sn_list` is limited to 1–50 entries. The returned order is not evidence of a Food Driver assignment. |
| `v2.order.get_shipment_list` (`/api/v2/order/get_shipment_list`) | List orders in `READY_TO_SHIP` or `RETRY_SHIP` for the marketplace shipping process | Not in the current read-only FOD scope | This is a seller shipping workflow, not the Food Driver dispatch/acceptance flow. |
| `v2.logistics.get_tracking_info` and `v2.logistics.get_tracking_number` | Retrieve tracking information/number for Shopee logistics shipments | Possibly display marketplace shipment status after authorization | Does not document Food Driver live location, driver offers, or delivery-app commands. |
| `v2.push.set_app_push_config` / `v2.push.get_app_push_config` | Configure/read the application's push callback settings; push type `3` is order-status update | Candidate event source for an authorized marketplace connector | Requires an approved application and supported push type. It does not establish Food Driver events are available. |
| `v2.push.get_lost_push_message` / `v2.push.confirm_consumed_lost_push_message` | Recover unconfirmed lost push messages and acknowledge the last consumed message | Webhook recovery/deduplication for an authorized marketplace connector | Official reference describes lost messages within the prior three days; implement durable deduplication and acknowledgement only against the current docs. |

The docs portal's per-method `rate_limit` field did not provide a usable numeric quota for the reviewed methods (the returned values were zero/blank). This is **not** evidence of unlimited access. Obtain the current app/method quota from the Open Platform console or Shopee, honor throttling responses, and use bounded time windows, cursor pagination, backoff, and webhook recovery instead of aggressive polling.

## Blocker and next authorized step

Ask Shopee/Open Platform support or the account's authorized Shopee representative to confirm, in writing:

- Whether ShopeeFood / Food Driver offers and order details are available through a public/partner API in Thailand.
- Which application type, approval, shop/merchant relationship, permissions, order lifecycle events, and webhook topics are required.
- Whether driver identity, delivery status, and live location are exposed, and which privacy/retention restrictions apply.
- The applicable endpoint host, per-method quotas, token lifecycle, and production onboarding requirements.

If the confirmed scope is marketplace shop orders only, treat that as a separate product decision. Design an import/review flow with explicit shop authorization, idempotency, order matching, and no automatic acceptance or status writes until separately authorized and tested.

## Official references

- [Shopee Open Platform](https://open.shopee.com/)
- [OpenAPI 2.0 Overview (document 58)](https://open.shopee.com/documents?module=87&type=2&id=58&version=2) — signing and common API concepts.
- [Developer Guide (document 59)](https://open.shopee.com/documents?module=87&type=2&id=59&version=2)
- [API Call Flows (document 60)](https://open.shopee.com/documents?module=87&type=2&id=60&version=2) — application/shop authorization and token flow.
- [Push Mechanism (WebHook) (document 63)](https://open.shopee.com/documents?module=87&type=2&id=63&version=2)
- [Order: get_order_list](https://open.shopee.com/documents/v2/v2.order.get_order_list?module=94&type=1&version=2)
- [Order: get_order_detail](https://open.shopee.com/documents/v2/v2.order.get_order_detail?module=94&type=1&version=2)
- [Order: get_shipment_list](https://open.shopee.com/documents/v2/v2.order.get_shipment_list?module=94&type=1&version=2)
- [Logistics: get_tracking_info](https://open.shopee.com/documents/v2/v2.logistics.get_tracking_info?module=95&type=1&version=2)
- [Logistics: get_tracking_number](https://open.shopee.com/documents/v2/v2.logistics.get_tracking_number?module=95&type=1&version=2)
- [Push: set_app_push_config](https://open.shopee.com/documents/v2/v2.push.set_app_push_config?module=105&type=1&version=2)
- [Push: get_lost_push_message](https://open.shopee.com/documents/v2/v2.push.get_lost_push_message?module=105&type=1&version=2)
- [Push: confirm_consumed_lost_push_message](https://open.shopee.com/documents/v2/v2.push.confirm_consumed_lost_push_message?module=105&type=1&version=2)

The official V2 catalog was inspected on 2026-10-25, including its Overview, Order, Logistics, and Push sections. No catalog module or API name for Food Driver / ShopeeFood order offers was found. This is a finding about the public catalog reviewed, not proof that no restricted, country-specific, or separately contracted API exists.
