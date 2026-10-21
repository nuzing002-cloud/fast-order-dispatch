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

  let dispatchDriverIds = ['1388246780'];

  function metricCard(label, value, hint) {
    return `
      <article class="stat">
        <span class="stat-label">${F.escapeHtml(label)}</span>
        <span class="stat-value">${F.escapeHtml(value)}</span>
        <span class="stat-hint">${F.escapeHtml(hint || '')}</span>
      </article>`;
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
  }

  document.getElementById('refreshButton').addEventListener('click', loadAll);
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
          totalAmount: 250,
          deliveryFee: 20,
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
})();
