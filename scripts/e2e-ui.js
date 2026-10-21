const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH || `${process.env.PREFIX}/bin/chromium-browser`;
const OUT = process.env.E2E_OUT_DIR || path.join(process.env.TMPDIR || '/tmp', 'fod-e2e');
const DRIVER = '1388246780';

fs.mkdirSync(OUT, { recursive: true });

function fail(message) {
  throw new Error(message);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log(`  shot: ${name}.png`);
}

function watch(page, errors) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText || ''}`));
}

async function open(page, errors, url) {
  errors.length = 0;
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle2', timeout: 30000 });
}

async function text(page, selector) {
  return page.$eval(selector, (el) => el.textContent.trim()).catch(() => null);
}

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(?=[:/]|$)/.test(BASE);

async function request(path, options) {
  const response = await fetch(`${BASE}${path}`, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${options?.method || 'GET'} ${path} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function cleanupDriverAssignments() {
  if (!LOCAL) return;
  const payload = await request(`/drivers/${DRIVER}`);
  for (const id of payload.driver?.assignedOrders ?? []) {
    const { order } = await request(`/orders/${id}`);
    const chain =
      {
        ASSIGNED: ['PICKED_UP', 'IN_DELIVERY', 'DELIVERED'],
        PICKED_UP: ['IN_DELIVERY', 'DELIVERED'],
        IN_DELIVERY: ['DELIVERED']
      }[order.status] ?? [];
    for (const status of chain) {
      await request(`/orders/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
    }
  }
}

async function run() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--disable-dbus', '--window-size=420,900']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, isMobile: true, hasTouch: true });
  const errors = [];
  const results = {};

  try {
    await cleanupDriverAssignments();

    // --- Home ---
    await open(page, errors, '/');
    await page.waitForFunction(() => document.getElementById('checkedAt')?.textContent !== '-', { timeout: 10000 });
    results.home = {
      health: await text(page, '#healthBadge'),
      checked: await text(page, '#checkedAt'),
      errors: [...errors]
    };
    if (!results.home.health.includes('ระบบทำงานปกติ')) fail(`home health: ${results.home.health}`);
    await shot(page, '01-home');

    // --- PWA assets ---
    results.pwa = await page.evaluate(async () => {
      const sw = await navigator.serviceWorker.getRegistration('/sw.js');
      const manifest = document.querySelector('link[rel="manifest"]');
      return {
        swScope: sw ? sw.scope : null,
        manifestHref: manifest ? manifest.href : null,
        themeColor: document.querySelector('meta[name="theme-color"]')?.content
      };
    });
    if (!results.pwa.manifestHref) fail('manifest link missing');
    if (!results.pwa.themeColor) fail('theme-color missing');

    // --- Customer: create order; it waits PENDING until the restaurant marks READY ---
    await open(page, errors, '/customer.html');
    await page.waitForSelector('#submitOrder');
    await page.click('#submitOrder');
    await page.waitForFunction(() => document.querySelector('#tracking .order-card, #tracking .card, #tracking [data-cancel]'), { timeout: 20000 });
    const orderBody = await text(page, '#tracking');
    const orderId = orderBody.match(/order_[a-z0-9-]+/i)?.[0];
    if (!orderId) fail(`no order id in tracking: ${orderBody?.slice(0, 200)}`);

    const beforeReady = await page.evaluate(async (id) => {
      const response = await fetch(`/orders/${encodeURIComponent(id)}`);
      return (await response.json()).order.status;
    }, orderId);
    if (beforeReady !== 'PENDING') fail(`order should wait for the restaurant, got ${beforeReady}`);

    const readyResponse = await page.evaluate(async (id) => {
      const response = await fetch(`/orders/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'READY' })
      });
      return { status: response.status, body: await response.json() };
    }, orderId);
    if (readyResponse.status !== 200) fail(`READY failed: ${JSON.stringify(readyResponse.body)}`);
    if (readyResponse.body.order.status !== 'ASSIGNED') fail(`READY was not dispatched: ${readyResponse.body.order.status}`);

    results.customer = { orderId, errors: [...errors] };
    await shot(page, '02-customer-order');

    // --- Driver: load, verify job, advance to DELIVERED ---
    await open(page, errors, '/driver.html');
    await page.waitForSelector('#loadDriver');
    await page.waitForFunction(() => document.getElementById('driverCard')?.textContent.includes('Target Driver'), { timeout: 15000 });
    await page.click('#loadDriver');
    await page.waitForFunction(() => document.getElementById('driverCard')?.textContent.includes('Target Driver'), { timeout: 15000 });
    try {
      await page.waitForFunction(
        (id) => document.getElementById('jobs')?.textContent.includes(id),
        { timeout: 20000 },
        orderId
      );
    } catch (driverErr) {
      const dbg = await page.evaluate(() => ({
        driverCard: document.getElementById('driverCard')?.textContent.trim(),
        jobs: document.getElementById('jobs')?.textContent.trim(),
        idValue: document.getElementById('driverIdInput')?.value
      }));
      await shot(page, '03-driver-timeout');
      console.error('driver jobs not found; debug:', JSON.stringify(dbg));
      fail(`driver jobs timeout: ${JSON.stringify(dbg)}`);
    }

    const advance = async (id, status) => {
      await page.evaluate((targetId) => {
        const target = document.querySelector(`[data-next][data-order="${targetId}"]`);
        if (!target) throw new Error(`no [data-next] for ${targetId}`);
        target.click();
      }, id);
      await page.waitForFunction(
        (targetId, next) => {
          const card = [...document.querySelectorAll('#jobs .order-card')].find((el) =>
            el.textContent.includes(targetId)
          );
          return Boolean(card?.querySelector(`.badge.status-${next}`));
        },
        { timeout: 15000 },
        id,
        status
      );
      await shot(page, `03-driver-${status.toLowerCase()}`);
    };

    await advance(orderId, 'PICKED_UP');
    await advance(orderId, 'IN_DELIVERY');
    await advance(orderId, 'DELIVERED');

    const delivered = await request(`/orders/${orderId}`);
    if (delivered.order?.status !== 'DELIVERED') {
      fail(`order ${orderId} is ${delivered.order?.status}, expected DELIVERED`);
    }
    await page.waitForFunction(
      () => document.getElementById('driverCard')?.textContent.includes('พร้อมรับงาน'),
      { timeout: 15000 }
    );
    results.driver = { advanced: 'DELIVERED', errors: [...errors] };

    // --- Admin: order visible with delivery stats ---
    await open(page, errors, '/admin.html');
    await page.waitForFunction(() => document.getElementById('ordersTable')?.textContent.includes('order_') || document.body.textContent.includes('DELIVERED') || document.body.textContent.includes('ส่งสำเร็จ'), { timeout: 20000 });
    results.admin = { sawDelivered: true, errors: [...errors] };
    await shot(page, '04-admin');

    const allErrors = [...results.home.errors, ...results.customer.errors, ...results.driver.errors, ...results.admin.errors];
    const summary = {
      ok: allErrors.length === 0,
      baseUrl: BASE,
      orderId: results.customer.orderId,
      pwa: results.pwa,
      consoleErrors: allErrors,
      shotsDir: OUT
    };
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (allErrors.length) {
      console.error('FAIL: browser errors');
      process.exitCode = 1;
    } else {
      console.log('E2E PASS');
    }
  } finally {
    await cleanupDriverAssignments().catch((cleanupErr) =>
      console.error('cleanup failed:', cleanupErr.message)
    );
    await browser.close();
  }
}

run().catch((err) => {
  console.error('E2E FAILED:', err.message);
  process.exit(1);
});
