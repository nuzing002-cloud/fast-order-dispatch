(function () {
  const F = window.FOD;
  F.bindKeyBar();

  const customerIdInput = document.getElementById('customerId');
  customerIdInput.value = `cust_${F.uuid().slice(0, 8)}`;

  const itemsBox = document.getElementById('items');
  const totalPreview = document.getElementById('totalPreview');
  const deliveryFeeInput = document.getElementById('deliveryFee');
  const form = document.getElementById('orderForm');
  const submitButton = document.getElementById('submitOrder');
  const trackInput = document.getElementById('trackId');
  const trackingBox = document.getElementById('tracking');

  let currentOrder = null;

  function addItemRow(item) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <input data-item-name placeholder="ชื่อเมนู" value="${F.escapeHtml(item?.name || 'ข้าวผัด')}" />
      <input data-item-qty type="number" min="1" step="1" value="${item?.quantity || 1}" />
      <input data-item-price type="number" min="0" step="any" value="${item?.price || 100}" />
      <button type="button" class="btn-danger btn-small" data-remove>ลบ</button>
    `;
    row.querySelector('[data-remove]').addEventListener('click', () => {
      if (itemsBox.children.length === 1) {
        F.toast('ต้องมีอย่างน้อย 1 รายการ', 'error');
        return;
      }
      row.remove();
      recalc();
    });
    row.addEventListener('input', recalc);
    itemsBox.appendChild(row);
    recalc();
  }

  function readItems() {
    return Array.from(itemsBox.querySelectorAll('.item-row')).map((row, index) => ({
      id: `item_${index + 1}`,
      name: row.querySelector('[data-item-name]').value.trim(),
      quantity: F.parseNumber(row.querySelector('[data-item-qty]').value, 0),
      price: F.parseNumber(row.querySelector('[data-item-price]').value, 0)
    }));
  }

  function recalc() {
    const items = readItems();
    const deliveryFee = F.parseNumber(deliveryFeeInput.value, 0);
    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0) + deliveryFee;
    totalPreview.textContent = F.money(total);
  }

  document.getElementById('addItem').addEventListener('click', () => addItemRow());
  deliveryFeeInput.addEventListener('input', recalc);
  addItemRow();

  function payload() {
    const items = readItems();
    const deliveryFee = F.parseNumber(deliveryFeeInput.value, 0);
    const totalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0) + deliveryFee;
    return {
      restaurant: {
        id: document.getElementById('restaurantId').value.trim(),
        name: document.getElementById('restaurantName').value.trim(),
        address: document.getElementById('restaurantAddress').value.trim(),
        phone: document.getElementById('restaurantPhone').value.trim(),
        preparationTime: F.parseNumber(document.getElementById('preparationTime').value, 0),
        latitude: F.parseNumber(document.getElementById('restaurantLat').value, NaN),
        longitude: F.parseNumber(document.getElementById('restaurantLng').value, NaN)
      },
      customer: {
        id: customerIdInput.value.trim(),
        name: document.getElementById('customerName').value.trim(),
        phone: document.getElementById('customerPhone').value.trim(),
        email: document.getElementById('customerEmail').value.trim() || undefined,
        address: document.getElementById('customerAddress').value.trim(),
        latitude: F.parseNumber(document.getElementById('customerLat').value, NaN),
        longitude: F.parseNumber(document.getElementById('customerLng').value, NaN)
      },
      items,
      totalAmount,
      deliveryFee,
      notes: document.getElementById('notes').value.trim() || undefined
    };
  }

  function validate(order) {
    if (!order.restaurant.id || !order.restaurant.name || !order.restaurant.address) {
      throw new Error('กรุณากรอกข้อมูลร้านให้ครบ');
    }
    if (!order.customer.id || !order.customer.name || !order.customer.address) {
      throw new Error('กรุณากรอกข้อมูลลูกค้าให้ครบ');
    }
    if (!Number.isFinite(order.restaurant.latitude) || !Number.isFinite(order.restaurant.longitude)) {
      throw new Error('พิกัดร้านไม่ถูกต้อง');
    }
    if (!Number.isFinite(order.customer.latitude) || !Number.isFinite(order.customer.longitude)) {
      throw new Error('พิกัดลูกค้าไม่ถูกต้อง');
    }
    if (order.items.some((item) => !item.name || item.quantity <= 0)) {
      throw new Error('กรุณากรอกรายการอาหารให้ครบ');
    }
    if (order.totalAmount <= 0) {
      throw new Error('ยอดรวมต้องมากกว่า 0');
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    let order;
    try {
      order = payload();
      validate(order);
    } catch (error) {
      F.toast(error.message, 'error');
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'กำลังดำเนินการ...';
    try {
      const result = await F.request('/orders', {
        method: 'POST',
        body: order,
        idempotencyKey: F.uuid()
      });
      trackInput.value = result.order.id;
      currentOrder = result.order;
      renderTracking(result.order, result);
      F.toast(
        result.batch
          ? `สร้างออเดอร์และมอบหมายให้ ${result.assignedDriverId} แล้ว`
          : `สร้างออเดอร์แล้ว รอคนขับว่าง (คิว ${result.queueSize})`,
        'success'
      );
    } catch (error) {
      if (error.payload && error.payload.order) {
        trackInput.value = error.payload.order.id;
        currentOrder = error.payload.order;
        renderTracking(error.payload.order, error.payload);
      }
      F.toast(error.message, 'error');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'ชำระเงินและสร้างออเดอร์';
    }
  });

  async function loadOrder(orderId) {
    if (!orderId) {
      F.toast('กรุณากรอก Order ID', 'error');
      return;
    }
    try {
      const payload = await F.request(`/orders/${encodeURIComponent(orderId)}`);
      const order = payload.order || payload;
      currentOrder = order;
      renderTracking(order);
    } catch (error) {
      trackingBox.innerHTML = `<p class="empty">ไม่พบออเดอร์ ${F.escapeHtml(orderId)}</p>`;
      F.toast(error.message, 'error');
    }
  }

  document.getElementById('trackButton').addEventListener('click', () => loadOrder(trackInput.value.trim()));
  trackInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      loadOrder(trackInput.value.trim());
    }
  });

  function timeline(order) {
    const index = F.progressIndex(order.status);
    if (index === -1) {
      return `<div class="row" style="margin-bottom: 10px">${F.orderBadge(order.status)}<span class="muted small">ออเดอร์สิ้นสุดแล้ว</span></div>`;
    }
    return `<ul class="timeline">${F.flow
      .map((status, position) => {
        const state = position < index ? 'done' : position === index ? 'current' : '';
        const stamps = {
          PENDING: order.createdAt,
          ASSIGNED: order.assignedAt,
          PICKED_UP: order.pickedUpAt,
          IN_DELIVERY: order.pickedUpAt,
          DELIVERED: order.deliveredAt
        };
        const stamp = stamps[status];
        return `<li class="${state}"><span>${F.orderLabel(status)}${
          stamp ? `<span class="muted small"> · ${F.time(stamp)}</span>` : ''
        }</span></li>`;
      })
      .join('')}</ul>`;
  }

  function actions(order) {
    const buttons = [];
    if (
      order.paymentStatus !== 'COMPLETED' &&
      order.paymentStatus !== 'REFUNDED' &&
      !['DELIVERED', 'CANCELLED', 'FAILED'].includes(order.status)
    ) {
      buttons.push(`<button class="btn-small" data-pay>ลองชำระเงินอีกครั้ง</button>`);
    }
    if (order.status === 'PENDING') {
      buttons.push(`<button class="btn-small btn-danger" data-cancel>ยกเลิกออเดอร์</button>`);
    }
    return buttons.join('');
  }

  function renderTracking(order, extra) {
    const batch = extra && extra.batch ? extra.batch : null;
    trackingBox.innerHTML = `
      <div class="order-card">
        <div class="order-card-head">
          <span class="mono">${F.escapeHtml(order.id)}</span>
          ${F.orderBadge(order.status)}
        </div>
        ${timeline(order)}
        <dl class="kv">
          <dt>ลูกค้า</dt><dd>${F.escapeHtml(order.customer.name)} · ${F.escapeHtml(order.customer.phone)}</dd>
          <dt>ที่อยู่</dt><dd>${F.escapeHtml(order.customer.address)}</dd>
          <dt>ร้าน</dt><dd>${F.escapeHtml(order.restaurant.name)}</dd>
          <dt>ยอดรวม</dt><dd>${F.money(order.totalAmount)} (ค่าส่ง ${F.money(order.deliveryFee)})</dd>
          <dt>การชำระเงิน</dt><dd>${F.paymentBadge(order.paymentStatus)}</dd>
          <dt>คนขับ</dt><dd>${F.escapeHtml(order.assignedDriverId || 'รอคนขับ')}</dd>
          ${batch ? `<dt>Batch</dt><dd class="mono">${F.escapeHtml(batch.id)}</dd>` : ''}
          ${batch ? `<dt>ETA</dt><dd>${F.minutes(batch.estimatedDurationMinutes)} · ${Number(batch.totalDistanceKm || 0).toFixed(2)} กม.</dd>` : ''}
          ${extra && extra.queueSize !== undefined ? `<dt>คิวคงเหลือ</dt><dd>${extra.queueSize} ออเดอร์</dd>` : ''}
        </dl>
        <div class="row">${actions(order)}</div>
      </div>
    `;

    const pay = trackingBox.querySelector('[data-pay]');
    if (pay) {
      pay.addEventListener('click', async () => {
        pay.disabled = true;
        try {
          const result = await F.request(`/orders/${encodeURIComponent(order.id)}/pay`, {
            method: 'POST',
            body: { method: 'card' },
            idempotencyKey: F.uuid()
          });
          renderTracking(result.order, result);
          F.toast('ชำระเงินและจ่ายงานสำเร็จ', 'success');
        } catch (error) {
          F.toast(error.message, 'error');
          pay.disabled = false;
        }
      });
    }

    const cancel = trackingBox.querySelector('[data-cancel]');
    if (cancel) {
      cancel.addEventListener('click', async () => {
        if (!confirm('ยืนยันยกเลิกออเดอร์นี้?')) return;
        cancel.disabled = true;
        try {
          const payload = await F.request(`/orders/${encodeURIComponent(order.id)}/status`, {
            method: 'PATCH',
            body: { status: 'CANCELLED' }
          });
          renderTracking(payload.order || payload);
          F.toast('ยกเลิกออเดอร์แล้ว', 'success');
        } catch (error) {
          F.toast(error.message, 'error');
          cancel.disabled = false;
        }
      });
    }
  }

  F.request('/health')
    .then((health) => {
      const badge = document.getElementById('paymentMode');
      badge.textContent = `payment: ${health.paymentProvider || 'mock'}`;
      badge.className = health.paymentProvider === 'mock' ? 'badge status-PENDING' : 'badge status-AVAILABLE';
    })
    .catch(() => {});

  F.connectSocket({
    'order:status': (event) => {
      if (currentOrder && event.order && event.order.id === currentOrder.id) {
        currentOrder = event.order;
        renderTracking(event.order);
      }
    },
    'payment:updated': (event) => {
      if (currentOrder && event.order && event.order.id === currentOrder.id) {
        currentOrder = event.order;
        renderTracking(event.order);
      }
    },
    'batch:assigned': (batch) => {
      if (currentOrder && batch.orderIds && batch.orderIds.includes(currentOrder.id)) {
        loadOrder(currentOrder.id);
      }
    }
  });

  setInterval(() => {
    if (currentOrder) loadOrder(currentOrder.id);
  }, 15000);
})();
