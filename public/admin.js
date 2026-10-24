(function () {
  const F = window.FOD;
  F.bindKeyBar();

  const ordersBody = document.getElementById('ordersBody');
  const driversBody = document.getElementById('driversBody');
  const batchesBody = document.getElementById('batchesBody');
  const metricsBox = document.getElementById('metrics');
  const kpiMetrics = document.getElementById('kpiMetrics');
  const kpiRangeLabel = document.getElementById('kpiRangeLabel');
  const kpiPerDay = document.getElementById('kpiPerDay');
  const kpiPerDriver = document.getElementById('kpiPerDriver');
  const auditBox = document.getElementById('auditList');
  const dispatchInfo = document.getElementById('dispatchInfo');
  const payoutSelect = document.getElementById('payoutDriver');
  const payoutsBody = document.getElementById('payoutsBody');
  const payoutPending = document.getElementById('payoutPending');

  const bridgeBadge = document.getElementById('bridgeBadge');
  const bridgeStats = document.getElementById('bridgeStats');
  const bridgeOrderCount = document.getElementById('bridgeOrderCount');
  const bridgeActivity = document.getElementById('bridgeActivity');
  const bridgeSyncInfo = document.getElementById('bridgeSyncInfo');
  const bridgeShot = document.getElementById('bridgeShot');
  const bridgeShotEmpty = document.getElementById('bridgeShotEmpty');
  const bridgeShotMeta = document.getElementById('bridgeShotMeta');
  let bridgeShotUrl = null;
  let lastBridgeShotAt = null;
  let selectedKpiDays = 7;

  let dispatchDriverIds = ['1388246780'];

  function metricCard(label, value, hint) {
    return `
      <article class="stat">
        <span class="stat-label">${F.escapeHtml(label)}</span>
        <span class="stat-value">${F.escapeHtml(value)}</span>
        <span class="stat-hint">${F.escapeHtml(hint || '')}</span>
      </article>`;
  }

  const BRIDGE_ORDER_LABELS = {
    new: 'งานใหม่',
    opened: 'เปิดดูแล้ว',
    accepted: 'รับแล้ว',
    failed: 'ล้มเหลว'
  };

  const BRIDGE_ORDER_CLASSES = {
    new: 'status-PENDING',
    opened: 'status-ASSIGNED',
    accepted: 'status-AVAILABLE',
    failed: 'status-FAILED'
  };

  const BRIDGE_EVENT_LABELS = {
    notification: 'แจ้งเตือน',
    updated: 'อัปเดตแจ้งเตือน',
    dismissed: 'ปิดแจ้งเตือน',
    action: 'การทำงาน'
  };

  function orderMatchesEvent(order, event) {
    if (order.eventId && event.id) return order.eventId === event.id;
    return event.order === true && order.key && event.key && order.key === event.key;
  }

  function renderBridgeActivity(events, orders) {
    const matchedOrders = new Set();
    const items = events.map((event) => {
      const order = orders.find(
        (candidate) => !matchedOrders.has(candidate) && orderMatchesEvent(candidate, event)
      );
      if (order) matchedOrders.add(order);
      return {
        event,
        order,
        time: event.time || order?.updatedAt || order?.createdAt || ''
      };
    });

    for (const order of orders) {
      if (!matchedOrders.has(order)) {
        items.push({
          event: null,
          order,
          time: order.updatedAt || order.createdAt || order.time || ''
        });
      }
    }

    items.sort((left, right) => {
      const leftTime = Date.parse(left.time) || 0;
      const rightTime = Date.parse(right.time) || 0;
      return rightTime - leftTime;
    });

    if (items.length === 0) {
      bridgeActivity.innerHTML = '<p class="muted small">ยังไม่มีออเดอร์หรือการแจ้งเตือน</p>';
      return;
    }

    bridgeActivity.innerHTML = `
      <div class="card-list">
        ${items
          .slice(0, 10)
          .map(({ event, order, time }) => {
            const isOrder = Boolean(order) || event?.order === true;
            const title = String(event?.title || (isOrder ? 'ออเดอร์ Shopee' : 'แจ้งเตือน'));
            const type = isOrder
              ? 'ออเดอร์'
              : BRIDGE_EVENT_LABELS[String(event?.type || '')] || String(event?.type || '-');
            const text = String(event?.text || event?.bigText || '').slice(0, 300);
            const orderId = order ? String(order.orderNo || order.id || order.key || '') : '';
            const statusValue = String(order?.status || '');
            const statusLabel = BRIDGE_ORDER_LABELS[statusValue] || statusValue;
            const statusClass = BRIDGE_ORDER_CLASSES[statusValue] || 'status-PENDING';
            const details = order
              ? [
                  orderId ? `งาน ${orderId}` : '',
                  order.price ? `฿${String(order.price)}` : '',
                  order.distance ? `${String(order.distance)} กม.` : '',
                  order.duration ? `${String(order.duration)} นาที` : ''
                ]
                  .filter(Boolean)
                  .join(' · ')
              : '';
            return `
              <div class="order-card">
                <div class="order-card-head">
                  <span><strong>${F.escapeHtml(title)}</strong></span>
                  <span class="muted small">${F.time(time)}</span>
                </div>
                <span class="muted small">
                  ${F.escapeHtml(type)}${text ? ` · ${F.escapeHtml(text)}` : ''}
                </span>
                ${
                  order
                    ? `<span class="small">${F.escapeHtml(details)} <span class="badge ${statusClass}">${F.escapeHtml(statusLabel || '-')}</span></span>`
                    : ''
                }
              </div>`;
          })
          .join('')}
      </div>`;
  }

  function renderBridge(status) {
    if (!status.configured) {
      bridgeBadge.className = 'badge status-PENDING';
      bridgeBadge.textContent = 'ยังไม่ตั้งค่า';
      bridgeStats.innerHTML = [
        metricCard('สะพาน Shopee', 'ปิดอยู่', 'ตั้งค่า SHOPEE_BRIDGE_URL'),
        metricCard('คำสั่งรับงาน', 'ไม่เปิดจาก 3000', 'read-only'),
        metricCard('ออเดอร์', '0', 'ยังไม่มีข้อมูล'),
        metricCard('เหตุการณ์', '0', 'ยังไม่มีข้อมูล')
      ].join('');
      bridgeOrderCount.textContent = '0 งาน';
      bridgeActivity.innerHTML = '<p class="muted small">ยังไม่ได้เชื่อมต่อสะพาน Shopee</p>';
      bridgeSyncInfo.textContent = 'ตั้งค่า SHOPEE_BRIDGE_URL ใน .env แล้วรีสตาร์ต 3000';
      return;
    }

    const health = status.health || {};
    const adb = health.adb || {};
    const orders = status.orders || [];
    const events = status.events || [];
    const autoAccept = health.autoAccept === true;
    const autoOpen = health.autoOpen === true;
    const freshness = status.dataFreshness || { state: 'unknown', reason: 'ไม่มีข้อมูล freshness' };
    const bridgeOnline = status.reachable === true;
    const bridgeFresh = freshness.state === 'fresh';
    const lastSync = status.lastSyncAt ? F.time(status.lastSyncAt) : 'ยังไม่เคย';
    const interval = status.syncIntervalMs
      ? `${Math.round(status.syncIntervalMs / 1000)} วิ`
      : '-';

    bridgeBadge.className = `badge ${bridgeOnline && bridgeFresh ? 'status-AVAILABLE' : 'status-FAILED'}`;
    bridgeBadge.textContent = bridgeOnline
      ? bridgeFresh
        ? 'เชื่อมต่อ 4020 แล้ว'
        : freshness.state === 'stale'
          ? 'ข้อมูล 4020 ค้าง'
          : '4020 ยังไม่ยืนยันข้อมูลสด'
      : '4020 ออฟไลน์';
    bridgeStats.innerHTML = [
      metricCard(
        'การเชื่อมต่อ',
        bridgeOnline ? (bridgeFresh ? 'ออนไลน์ · สด' : 'ออนไลน์ · ค้าง') : 'ออฟไลน์',
        freshness.reason || status.baseUrl || '-'
      ),
      metricCard(
        'ADB',
        adb.ok === true ? 'พร้อม' : 'ไม่พร้อม',
        adb.serial ? `เครื่อง ${adb.serial}` : adb.error || '-'
      ),
      metricCard('ออเดอร์ Shopee', String(orders.length), `${events.length} เหตุการณ์`),
      metricCard(
        'โหมดใน 4020',
        autoAccept ? 'รับอัตโนมัติ' : 'รับเอง',
        `เปิดแอปอัตโนมัติ ${autoOpen ? 'เปิด' : 'ปิด'}`
      )
    ].join('');
    bridgeOrderCount.textContent = `${orders.length} งาน`;
    bridgeSyncInfo.textContent = [
      `ซิงก์ล่าสุด ${lastSync}`,
      `ทุก ${interval}`,
      `ข้อมูล ${freshness.state || 'unknown'}`,
      status.lastError ? `• ${status.lastError}` : ''
    ]
      .filter(Boolean)
      .join(' • ');

    renderBridgeActivity(events, orders);
  }

  async function loadBridgeShot(status) {
    const screenshot = status.screenshot || {};
    if (!status.configured || !screenshot.available) {
      if (bridgeShotUrl) {
        URL.revokeObjectURL(bridgeShotUrl);
        bridgeShotUrl = null;
      }
      lastBridgeShotAt = null;
      bridgeShot.hidden = true;
      bridgeShot.removeAttribute('src');
      bridgeShotEmpty.hidden = false;
      bridgeShotEmpty.textContent = status.configured
        ? 'ยังไม่มีภาพ — กด “ตรวจพื้นที่” ในคอนโซล 4020 ก่อน'
        : 'ยังไม่ได้ตั้งค่าสะพาน Shopee';
      bridgeShotMeta.textContent = '-';
      return;
    }
    if (lastBridgeShotAt === screenshot.updatedAt && bridgeShot.src) {
      bridgeShotMeta.textContent = `${F.time(screenshot.updatedAt)} · ${Math.round(
        Number(screenshot.bytes || 0) / 1024
      )} KB`;
      return;
    }
    try {
      const headers = {};
      const key = F.getKey();
      if (key) headers['x-api-key'] = key;
      const response = await fetch('/integrations/shopee-bridge/screenshot', { headers });
      if (!response.ok) {
        bridgeShot.hidden = true;
        bridgeShotEmpty.hidden = false;
        bridgeShotEmpty.textContent =
          response.status === 401
            ? 'ต้องใส่ API key เพื่อดูภาพ'
            : `โหลดภาพไม่สำเร็จ (HTTP ${response.status})`;
        bridgeShotMeta.textContent = '-';
        return;
      }
      const blob = await response.blob();
      if (bridgeShotUrl) URL.revokeObjectURL(bridgeShotUrl);
      bridgeShotUrl = URL.createObjectURL(blob);
      bridgeShot.src = bridgeShotUrl;
      bridgeShot.hidden = false;
      bridgeShotEmpty.hidden = true;
      bridgeShotMeta.textContent = `${F.time(screenshot.updatedAt)} · ${Math.round(
        blob.size / 1024
      )} KB`;
      lastBridgeShotAt = screenshot.updatedAt;
    } catch (error) {
      bridgeShot.hidden = true;
      bridgeShotEmpty.hidden = false;
      bridgeShotEmpty.textContent = `โหลดภาพไม่สำเร็จ: ${error.message}`;
    }
  }

  async function loadBridge() {
    try {
      const status = await F.request('/integrations/shopee-bridge/status');
      renderBridge(status);
      await loadBridgeShot(status);
    } catch (error) {
      bridgeBadge.className = 'badge status-FAILED';
      bridgeBadge.textContent = 'โหลดสถานะไม่สำเร็จ';
      bridgeSyncInfo.textContent = error.message;
    }
  }

  async function loadHealth() {
    try {
      const health = await F.request('/health');
      dispatchDriverIds = health.dispatchDriverIds || dispatchDriverIds;
      dispatchInfo.innerHTML = `
        storage: <strong>${F.escapeHtml(health.storage)}</strong> ·
        payment: <strong>${F.escapeHtml(health.paymentProvider || 'mock')}</strong> ·
        คิว: <strong>${health.queueSize}</strong> ·
        driver ที่รับงาน: <strong>${F.escapeHtml(dispatchDriverIds.join(', '))}</strong> ·
        uptime: ${health.uptimeSeconds}s`;
    } catch (error) {
      dispatchInfo.textContent = `โหลดสถานะไม่สำเร็จ: ${error.message}`;
    }
  }

  async function loadMetrics() {
    try {
      const metrics = await F.request('/metrics');
      metricsBox.innerHTML = [
        metricCard('ออเดอร์ที่จ่ายงานแล้ว', metrics.totalOrdersProcessed, 'assigned แล้ว'),
        metricCard('Batch ทั้งหมด', metrics.totalBatchesCreated, 'ชุดที่สร้าง'),
        metricCard('คิวรอ', metrics.pendingOrders, 'PENDING + queued'),
        metricCard('คนขับพร้อมงาน', metrics.activeDrivers, 'AVAILABLE'),
        metricCard('อัตราสำเร็จ', `${(Number(metrics.successRate || 0) * 100).toFixed(1)}%`, 'delivered / terminal'),
        metricCard('รายได้', F.money(metrics.totalRevenue), 'ไม่รวม refund'),
        metricCard('เวลาเฉลี่ยถึงมือคนขับ', `${Math.round(Number(metrics.averageProcessingTime || 0))} ms`, 'created → assigned'),
        metricCard('เวลาเฉลี่ยจัดส่งสำเร็จ', F.minutes(Number(metrics.averageDeliveryTime || 0) / 60000), 'assigned → delivered')
      ].join('');
    } catch (error) {
      metricsBox.innerHTML = `<div class="card"><p class="empty">โหลด metrics ไม่สำเร็จ: ${F.escapeHtml(error.message)}</p></div>`;
    }
  }

  function bangkokDateKey(date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  async function loadKpi(days = selectedKpiDays) {
    selectedKpiDays = days;
    const now = new Date();
    const currentDay = new Date(`${bangkokDateKey(now)}T00:00:00.000Z`);
    currentDay.setUTCDate(currentDay.getUTCDate() - days + 1);
    const from = new Date(`${currentDay.toISOString().slice(0, 10)}T00:00:00+07:00`);
    const query = new URLSearchParams({ from: from.toISOString(), to: now.toISOString() });
    try {
      const report = await F.request(`/metrics/kpi?${query}`);
      const totals = report.totals;
      const percent = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`;
      const duration = (value) => `${Math.round(Number(value || 0) / 1000)} วินาที`;
      kpiRangeLabel.textContent = `${new Intl.DateTimeFormat('th-TH', {
        timeZone: 'Asia/Bangkok',
        dateStyle: 'medium'
      }).format(from)} – ${new Intl.DateTimeFormat('th-TH', {
        timeZone: 'Asia/Bangkok',
        dateStyle: 'medium'
      }).format(now)}`;
      kpiMetrics.innerHTML = [
        metricCard('สร้างออเดอร์', totals.ordersCreated, 'ตามวันสร้าง'),
        metricCard('ส่งสำเร็จ', totals.delivered, 'ออเดอร์ที่จัดส่งแล้ว'),
        metricCard('กำลังดำเนินการ', totals.inProgress, 'ยังไม่จบงาน'),
        metricCard('ยกเลิก', totals.cancelled, 'ออเดอร์ที่ยกเลิก'),
        metricCard('ล้มเหลว', totals.failed, 'ออเดอร์ที่ล้มเหลว'),
        metricCard('อัตราสำเร็จ', percent(totals.successRate), 'ส่งสำเร็จ / งานที่จบ'),
        metricCard('ส่งตรงเวลา', percent(totals.onTimeRate), 'เฉพาะงานที่มีเวลา ETA'),
        metricCard('รอคิวเฉลี่ย', duration(totals.avgQueueWaitMs), 'เข้าคิว → จ่ายงาน'),
        metricCard('รอรับอาหารเฉลี่ย', duration(totals.avgPickupMs), 'จ่ายงาน → รับอาหาร'),
        metricCard('เวลาส่งเฉลี่ย', duration(totals.avgDeliveryMs), 'รับอาหาร → ส่งสำเร็จ'),
        metricCard('รายได้', F.money(totals.revenue), 'ส่งสำเร็จ ไม่รวมคืนเงิน'),
        metricCard('ค่าส่งรวม', F.money(totals.deliveryFees), 'ออเดอร์ที่ส่งสำเร็จ'),
        metricCard('ยอดเฉลี่ยต่อออเดอร์', F.money(totals.avgOrderValue), 'เฉพาะรายได้ที่ไม่คืนเงิน')
      ].join('');
      kpiPerDay.innerHTML = report.perDay.length
        ? report.perDay
            .map(
              (day) => `
                <tr>
                  <td>${F.escapeHtml(day.date)}</td>
                  <td>${F.escapeHtml(day.ordersCreated)}</td>
                  <td>${F.escapeHtml(day.delivered)}</td>
                  <td>${F.money(day.revenue)}</td>
                </tr>`
            )
            .join('')
        : '<tr><td colspan="4" class="empty">ไม่มีข้อมูลในช่วงนี้</td></tr>';
      kpiPerDriver.innerHTML = report.perDriver.length
        ? report.perDriver
            .map(
              (driver) => `
                <tr>
                  <td class="mono">${F.escapeHtml(driver.driverId)}</td>
                  <td>${F.escapeHtml(driver.delivered)}</td>
                  <td>${duration(driver.avgDeliveryMs)}</td>
                  <td>${F.money(driver.deliveryFees)}</td>
                  <td>${F.money(driver.earnings)}</td>
                </tr>`
            )
            .join('')
        : '<tr><td colspan="5" class="empty">ไม่มีข้อมูลในช่วงนี้</td></tr>';
    } catch (error) {
      kpiRangeLabel.textContent = 'รายงาน KPI';
      kpiMetrics.innerHTML = `<div class="card"><p class="empty">โหลดรายงานไม่สำเร็จ: ${F.escapeHtml(error.message)}</p></div>`;
      kpiPerDay.innerHTML = '<tr><td colspan="4" class="empty">โหลดรายงานไม่สำเร็จ</td></tr>';
      kpiPerDriver.innerHTML = '<tr><td colspan="5" class="empty">โหลดรายงานไม่สำเร็จ</td></tr>';
    }
  }

  function orderActions(order) {
    const buttons = F.nextStatuses(order.status)
      .map(
        (status) =>
          `<button class="btn-small" data-order="${F.escapeHtml(order.id)}" data-status="${status}">${F.orderLabel(status)}</button>`
      )
      .join('');
    const pay =
      order.paymentStatus !== 'COMPLETED' &&
      order.paymentStatus !== 'REFUNDED' &&
      !['DELIVERED', 'CANCELLED', 'FAILED'].includes(order.status)
        ? `<button class="btn-small" data-pay="${F.escapeHtml(order.id)}">ชำระอีกครั้ง</button>`
        : '';
    const refund =
      order.paymentStatus === 'COMPLETED'
        ? `<button class="btn-small btn-danger" data-refund="${F.escapeHtml(order.id)}">คืนเงิน</button>`
        : '';
    return buttons + pay + refund;
  }

  async function loadOrders() {
    try {
      const data = await F.request('/orders?limit=50&offset=0');
      if (!data.orders.length) {
        ordersBody.innerHTML = `<tr><td colspan="7" class="empty">ยังไม่มีออเดอร์</td></tr>`;
        return;
      }
      ordersBody.innerHTML = data.orders
        .map(
          (order) => `
          <tr>
            <td class="mono" title="${F.escapeHtml(order.id)}">${F.escapeHtml(order.id.slice(-10))}</td>
            <td>${F.orderBadge(order.status)}</td>
            <td>${F.paymentBadge(order.paymentStatus)}</td>
            <td>${F.money(order.totalAmount)}</td>
            <td>${F.escapeHtml(order.assignedDriverId || '-')}</td>
            <td>${F.time(order.createdAt)}</td>
            <td><div class="row">${orderActions(order)}</div></td>
          </tr>`
        )
        .join('');
    } catch (error) {
      ordersBody.innerHTML = `<tr><td colspan="7" class="empty">โหลดออเดอร์ไม่สำเร็จ: ${F.escapeHtml(error.message)}</td></tr>`;
    }
  }

  async function loadDrivers() {
    try {
      const data = await F.request('/drivers');
      document.getElementById('driverCount').textContent = `${data.drivers.length} คน`;
      if (!data.drivers.length) {
        driversBody.innerHTML = `<tr><td colspan="6" class="empty">ยังไม่มีคนขับ</td></tr>`;
        return;
      }
      const previous = payoutSelect.value;
      payoutSelect.innerHTML = data.drivers
        .map(
          (driver) =>
            `<option value="${F.escapeHtml(driver.id)}">${F.escapeHtml(driver.name || driver.id)} (${F.escapeHtml(driver.id)})</option>`
        )
        .join('');
      if (previous && data.drivers.some((driver) => driver.id === previous)) {
        payoutSelect.value = previous;
      }
      await loadPayoutPending();

      driversBody.innerHTML = data.drivers
        .map(
          (driver) => `
          <tr>
            <td class="mono">${F.escapeHtml(driver.id)}</td>
            <td>${F.escapeHtml(driver.name || '-')}</td>
            <td>${F.driverBadge(driver.status)}</td>
            <td>${driver.assignedOrders.length} / ${driver.maxOrdersPerBatch}</td>
            <td class="mono small">${Number(driver.currentLatitude).toFixed(4)}, ${Number(driver.currentLongitude).toFixed(4)}</td>
            <td>${F.time(driver.lastLocationUpdate)}</td>
          </tr>`
        )
        .join('');
    } catch (error) {
      driversBody.innerHTML = `<tr><td colspan="6" class="empty">โหลดคนขับไม่สำเร็จ: ${F.escapeHtml(error.message)}</td></tr>`;
    }
  }

  async function loadPayoutPending() {
    const driverId = payoutSelect.value;
    if (!driverId) {
      payoutPending.textContent = 'ยังไม่มีคนขับให้จ่ายเงิน';
      return;
    }
    try {
      const summary = await F.request(`/drivers/${encodeURIComponent(driverId)}/earnings`);
      const count = summary.earnings.filter((earning) => earning.status === 'PENDING').length;
      payoutPending.textContent = `ยอดค้างจ่าย: ${F.money(summary.pendingAmount)} (${count} รายการ)`;
    } catch (error) {
      payoutPending.textContent = `โหลดยอดค้างจ่ายไม่สำเร็จ: ${error.message}`;
    }
  }

  async function loadPayouts() {
    try {
      const data = await F.request('/payouts?limit=20&offset=0');
      document.getElementById('payoutCount').textContent = `${data.total} ครั้ง`;
      if (!data.payouts.length) {
        payoutsBody.innerHTML = `<tr><td colspan="6" class="empty">ยังไม่มีการจ่ายเงิน</td></tr>`;
        return;
      }
      payoutsBody.innerHTML = data.payouts
        .map(
          (payout) => `
          <tr>
            <td class="mono" title="${F.escapeHtml(payout.id)}">${F.escapeHtml(payout.id.slice(-10))}</td>
            <td class="mono">${F.escapeHtml(payout.driverId)}</td>
            <td>${F.money(payout.amount)}</td>
            <td>${F.escapeHtml(payout.method || '-')}</td>
            <td>${F.escapeHtml(payout.reference || '-')}</td>
            <td>${F.time(payout.paidAt)}</td>
          </tr>`
        )
        .join('');
    } catch (error) {
      payoutsBody.innerHTML = `<tr><td colspan="6" class="empty">${
        error.status === 403
          ? 'ต้องใช้ API key role admin เพื่อดูประวัติการจ่ายเงิน'
          : `โหลดประวัติการจ่ายเงินไม่สำเร็จ: ${F.escapeHtml(error.message)}`
      }</td></tr>`;
    }
  }

  async function loadBatches() {
    try {
      const data = await F.request('/batches?limit=20&offset=0');
      document.getElementById('batchCount').textContent = `${data.total} ชุด`;
      if (!data.batches.length) {
        batchesBody.innerHTML = `<tr><td colspan="7" class="empty">ยังไม่มี batch</td></tr>`;
        return;
      }
      batchesBody.innerHTML = data.batches
        .map(
          (batch) => `
          <tr>
            <td class="mono" title="${F.escapeHtml(batch.id)}">${F.escapeHtml(batch.id.slice(-10))}</td>
            <td>${F.escapeHtml(batch.driverId)}</td>
            <td>${batch.orderIds.length}</td>
            <td>${Number(batch.totalDistanceKm || 0).toFixed(2)} กม.</td>
            <td>${F.minutes(batch.estimatedDurationMinutes)}</td>
            <td>${F.time(batch.createdAt)}</td>
            <td>${F.time(batch.completedAt)}</td>
          </tr>`
        )
        .join('');
    } catch (error) {
      batchesBody.innerHTML = `<tr><td colspan="7" class="empty">โหลด batch ไม่สำเร็จ: ${F.escapeHtml(error.message)}</td></tr>`;
    }
  }

  async function loadAudit() {
    try {
      const data = await F.request('/audit?limit=20&offset=0');
      if (!data.entries.length) {
        auditBox.innerHTML = `<p class="muted small">ยังไม่มีรายการ audit</p>`;
        return;
      }
      auditBox.innerHTML = `
        <div class="card-list">
          ${data.entries
            .map(
              (entry) => `
              <div class="order-card">
                <div class="order-card-head">
                  <span><strong>${F.escapeHtml(entry.action)}</strong> · ${F.escapeHtml(entry.entityType)} ${F.escapeHtml(entry.entityId)}</span>
                  <span class="muted small">${F.time(entry.timestamp)}</span>
                </div>
                <span class="muted small">actor: ${F.escapeHtml(entry.actor)} (${F.escapeHtml(entry.role)}) · ip: ${F.escapeHtml(entry.ip || '-')}</span>
              </div>`
            )
            .join('')}
        </div>`;
    } catch (error) {
      auditBox.innerHTML = `<p class="muted small">${
        error.status === 403
          ? 'ต้องใช้ API key role admin เพื่อดู audit'
          : `โหลด audit ไม่สำเร็จ: ${F.escapeHtml(error.message)}`
      }</p>`;
    }
  }

  function loadAll() {
    loadHealth();
    loadMetrics();
    loadKpi();
    loadOrders();
    loadDrivers();
    loadPayouts();
    loadBatches();
    loadAudit();
    loadBridge();
  }

  document.getElementById('refreshButton').addEventListener('click', loadAll);
  document.querySelectorAll('[data-kpi-days]').forEach((button) => {
    button.addEventListener('click', () => {
      const days = Number(button.dataset.kpiDays);
      if (![1, 7, 30].includes(days)) return;
      selectedKpiDays = days;
      document.querySelectorAll('[data-kpi-days]').forEach((rangeButton) => {
        rangeButton.classList.toggle('btn-primary', rangeButton === button);
      });
      loadKpi(days);
    });
  });
  document.getElementById('bridgeSyncButton').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const status = await F.request('/integrations/shopee-bridge/sync', {
        method: 'POST',
        body: {}
      });
      renderBridge(status);
      await loadBridgeShot(status);
      F.toast(status.reachable ? 'ซิงก์สถานะ Shopee แล้ว' : 'ซิงก์แล้ว แต่ยังเชื่อมต่อ 4020 ไม่ได้', status.reachable ? 'success' : 'error');
    } catch (error) {
      F.toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
  payoutSelect.addEventListener('change', loadPayoutPending);

  document.getElementById('payoutButton').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const driverId = payoutSelect.value;
    if (!driverId) {
      F.toast('เลือกคนขับก่อน', 'error');
      return;
    }
    if (!confirm(`ยืนยันจ่ายเงินคนขับ ${driverId} ตามยอดค้างทั้งหมด?`)) return;
    button.disabled = true;
    try {
      const result = await F.request('/payouts', {
        method: 'POST',
        idempotencyKey: F.uuid(),
        body: {
          driverId,
          method: document.getElementById('payoutMethod').value.trim() || 'transfer',
          reference: document.getElementById('payoutReference').value.trim() || undefined,
          note: document.getElementById('payoutNote').value.trim() || undefined
        }
      });
      F.toast(`บันทึกจ่ายเงิน ${F.money(result.payout.amount)} แล้ว`, 'success');
      document.getElementById('payoutReference').value = '';
      document.getElementById('payoutNote').value = '';
      loadAll();
    } catch (error) {
      F.toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('dispatchButton').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await F.request('/dispatch/process', { method: 'POST', body: {} });
      if (result.batch) {
        F.toast(`จ่ายงานให้ ${result.batch.driverId} จำนวน ${result.batch.orderIds.length} ออเดอร์`, 'success');
      } else {
        F.toast(`ยังไม่มีงานที่จ่ายได้ (คิว ${result.queueSize})`);
      }
      loadAll();
    } catch (error) {
      F.toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('driverForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {
      id: document.getElementById('newDriverId').value.trim(),
      name: document.getElementById('newDriverName').value.trim(),
      phone: document.getElementById('newDriverPhone').value.trim(),
      vehicle: document.getElementById('newDriverVehicle').value.trim(),
      licensePlate: document.getElementById('newDriverPlate').value.trim(),
      maxOrdersPerBatch: F.parseNumber(document.getElementById('newDriverCapacity').value, 3),
      currentLatitude: F.parseNumber(document.getElementById('newDriverLat').value, NaN),
      currentLongitude: F.parseNumber(document.getElementById('newDriverLng').value, NaN)
    };
    if (!body.id || !body.name || !body.phone || !body.vehicle || !body.licensePlate) {
      F.toast('กรุณากรอกข้อมูลคนขับให้ครบ', 'error');
      return;
    }
    if (!Number.isFinite(body.currentLatitude) || !Number.isFinite(body.currentLongitude)) {
      F.toast('พิกัดไม่ถูกต้อง', 'error');
      return;
    }
    try {
      await F.request('/drivers', { method: 'POST', body });
      F.toast('ลงทะเบียนคนขับแล้ว', 'success');
      loadAll();
    } catch (error) {
      F.toast(error.message, 'error');
    }
  });

  document.getElementById('seedButton').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const drivers = (await F.request('/drivers')).drivers;
      const targetId = dispatchDriverIds[0];
      if (!drivers.some((driver) => driver.id === targetId)) {
        await F.request('/drivers', {
          method: 'POST',
          body: {
            id: targetId,
            name: 'Target Driver',
            phone: '0000000000',
            vehicle: 'motorcycle',
            licensePlate: 'TARGET',
            maxOrdersPerBatch: 3,
            currentLatitude: 13.7563,
            currentLongitude: 100.5018
          }
        });
      }
      const suffix = F.uuid().slice(0, 8);
      const result = await F.request('/orders', {
        method: 'POST',
        idempotencyKey: F.uuid(),
        body: {
          restaurant: {
            id: `r_${suffix}`,
            name: 'ร้านทดสอบ',
            address: '123 ถนนสุขุมวิท กรุงเทพฯ',
            phone: '0000000000',
            preparationTime: 10,
            latitude: 13.7563,
            longitude: 100.5018
          },
          customer: {
            id: `c_${suffix}`,
            name: 'ลูกค้าตัวอย่าง',
            phone: '0000000000',
            address: '456 ถนนพระราม 9 กรุงเทพฯ',
            latitude: 13.7466,
            longitude: 100.5347
          },
          items: [{ id: `i_${suffix}`, name: 'ข้าวผัด', quantity: 1, price: 230 }],
          totalAmount: 258,
          deliveryFee: 28,
          notes: 'ออเดอร์ตัวอย่าง'
        }
      });
      F.toast(
        result.batch
          ? `สร้างออเดอร์และจ่ายงานให้ ${result.assignedDriverId} แล้ว`
          : `สร้างออเดอร์แล้ว แต่ยังรอคนขับว่าง (คิว ${result.queueSize})`,
        'success'
      );
      loadAll();
    } catch (error) {
      F.toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  ordersBody.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const statusButton = target.closest('[data-status]');
    const payButton = target.closest('[data-pay]');
    const refundButton = target.closest('[data-refund]');

    if (statusButton) {
      statusButton.disabled = true;
      try {
        await F.request(`/orders/${encodeURIComponent(statusButton.dataset.order)}/status`, {
          method: 'PATCH',
          body: { status: statusButton.dataset.status }
        });
        F.toast('อัปเดตสถานะแล้ว', 'success');
        loadAll();
      } catch (error) {
        F.toast(error.message, 'error');
        statusButton.disabled = false;
      }
    }

    if (payButton) {
      payButton.disabled = true;
      try {
        const result = await F.request(`/orders/${encodeURIComponent(payButton.dataset.pay)}/pay`, {
          method: 'POST',
          body: { method: 'card' },
          idempotencyKey: F.uuid()
        });
        F.toast(result.batch ? 'ชำระเงินและจ่ายงานแล้ว' : 'ชำระเงินแล้ว รอคนขับว่าง', 'success');
        loadAll();
      } catch (error) {
        F.toast(error.message, 'error');
        payButton.disabled = false;
      }
    }

    if (refundButton) {
      if (!confirm('ยืนยันคืนเงินออเดอร์นี้?')) return;
      refundButton.disabled = true;
      try {
        await F.request(`/orders/${encodeURIComponent(refundButton.dataset.refund)}/refund`, {
          method: 'POST',
          body: { method: 'card' },
          idempotencyKey: F.uuid()
        });
        F.toast('คืนเงินแล้ว', 'success');
        loadAll();
      } catch (error) {
        F.toast(error.message, 'error');
        refundButton.disabled = false;
      }
    }
  });

  const refresh = F.debounce(loadAll, 600);
  F.connectSocket({
    'order:created': refresh,
    'order:queued': refresh,
    'order:status': refresh,
    'payment:updated': refresh,
    'payment:recorded': refresh,
    'batch:assigned': refresh,
    'batch:completed': refresh,
    'driver:updated': refresh,
    'earning:created': refresh,
    'payout:created': refresh
  });

  loadAll();
  setInterval(loadAll, 25000);
  setInterval(loadBridge, 10000);
})();
