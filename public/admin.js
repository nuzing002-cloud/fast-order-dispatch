(function () {
  const F = window.FOD;
  F.bindKeyBar();

  const ordersBody = document.getElementById('ordersBody');
  const driversBody = document.getElementById('driversBody');
  const batchesBody = document.getElementById('batchesBody');
  const metricsBox = document.getElementById('metrics');
  const auditBox = document.getElementById('auditList');
  const dispatchInfo = document.getElementById('dispatchInfo');
  const payoutSelect = document.getElementById('payoutDriver');
  const payoutsBody = document.getElementById('payoutsBody');
  const payoutPending = document.getElementById('payoutPending');

  const bridgeBadge = document.getElementById('bridgeBadge');
  const bridgeStats = document.getElementById('bridgeStats');
  const bridgeOrders = document.getElementById('bridgeOrders');
  const bridgeOrderCount = document.getElementById('bridgeOrderCount');
  const bridgeEvents = document.getElementById('bridgeEvents');
  const bridgeSyncInfo = document.getElementById('bridgeSyncInfo');
  const bridgeShot = document.getElementById('bridgeShot');
  const bridgeShotEmpty = document.getElementById('bridgeShotEmpty');
  const bridgeShotMeta = document.getElementById('bridgeShotMeta');
  let bridgeShotUrl = null;
  let lastBridgeShotAt = null;

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
      bridgeOrders.innerHTML =
        '<tr><td colspan="6" class="empty">ยังไม่ได้เชื่อมต่อสะพาน Shopee</td></tr>';
      bridgeEvents.innerHTML = '<p class="muted small">ยังไม่ได้เชื่อมต่อสะพาน Shopee</p>';
      bridgeSyncInfo.textContent = 'ตั้งค่า SHOPEE_BRIDGE_URL ใน .env แล้วรีสตาร์ต 3000';
      return;
    }

    const health = status.health || {};
    const adb = health.adb || {};
    const orders = status.orders || [];
    const events = status.events || [];
    const autoAccept = health.autoAccept === true;
    const autoOpen = health.autoOpen === true;
    const lastSync = status.lastSyncAt ? F.time(status.lastSyncAt) : 'ยังไม่เคย';
    const interval = status.syncIntervalMs
      ? `${Math.round(status.syncIntervalMs / 1000)} วิ`
      : '-';

    bridgeBadge.className = `badge ${status.reachable ? 'status-AVAILABLE' : 'status-FAILED'}`;
    bridgeBadge.textContent = status.reachable ? 'เชื่อมต่อ 4020 แล้ว' : '4020 ออฟไลน์';
    bridgeStats.innerHTML = [
      metricCard('การเชื่อมต่อ', status.reachable ? 'ออนไลน์' : 'ออฟไลน์', status.baseUrl || '-'),
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
      status.lastError ? `• ${status.lastError}` : ''
    ]
      .filter(Boolean)
      .join(' • ');

    if (orders.length === 0) {
      bridgeOrders.innerHTML =
        '<tr><td colspan="6" class="empty">ยังไม่มีงานจาก Shopee</td></tr>';
    } else {
      bridgeOrders.innerHTML = orders
        .map((order) => {
          const orderId = String(order.orderNo || order.id || order.key || '-');
          const shortId = orderId.length > 18 ? orderId.slice(-18) : orderId;
          const statusValue = String(order.status || '-');
          const statusLabel = BRIDGE_ORDER_LABELS[statusValue] || statusValue;
          const statusClass = BRIDGE_ORDER_CLASSES[statusValue] || 'status-PENDING';
          return `
          <tr>
            <td class="mono" title="${F.escapeHtml(orderId)}">${F.escapeHtml(shortId)}</td>
            <td><span class="badge ${statusClass}">${F.escapeHtml(statusLabel)}</span></td>
            <td>${order.price ? `฿${F.escapeHtml(String(order.price))}` : '-'}</td>
            <td>${order.distance ? `${F.escapeHtml(String(order.distance))} กม.` : '-'}</td>
            <td>${order.duration ? `${F.escapeHtml(String(order.duration))} นาที` : '-'}</td>
            <td>${F.time(order.updatedAt || order.createdAt)}</td>
          </tr>`;
        })
        .join('');
    }

    if (events.length === 0) {
      bridgeEvents.innerHTML = '<p class="muted small">ยังไม่มีเหตุการณ์</p>';
    } else {
      bridgeEvents.innerHTML = `
        <div class="card-list">
          ${events
            .slice(0, 10)
            .map((event) => {
              const type = String(event.type || '-');
              const title = String(event.title || '-');
              const text = String(event.text || '').slice(0, 300);
              return `
              <div class="order-card">
                <div class="order-card-head">
                  <span><strong>${F.escapeHtml(title)}</strong></span>
                  <span class="muted small">${F.time(event.time)}</span>
                </div>
                <span class="muted small">${F.escapeHtml(type)}${text ? ` · ${F.escapeHtml(text)}` : ''}</span>
              </div>`;
            })
            .join('')}
        </div>`;
    }
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
    loadOrders();
    loadDrivers();
    loadPayouts();
    loadBatches();
    loadAudit();
    loadBridge();
  }

  document.getElementById('refreshButton').addEventListener('click', loadAll);
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
