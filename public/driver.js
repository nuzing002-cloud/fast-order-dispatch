(function () {
  const F = window.FOD;
  F.bindKeyBar();

  const idInput = document.getElementById('driverIdInput');
  const driverCard = document.getElementById('driverCard');
  const jobsBox = document.getElementById('jobs');
  const liveBadge = document.getElementById('liveBadge');

  idInput.value = F.getDriverId() || '1388246780';

  let currentDriver = null;
  let jobs = [];

  async function loadDriver() {
    const id = idInput.value.trim();
    if (!id) {
      F.toast('กรุณากรอก Driver ID', 'error');
      return;
    }
    F.setDriverId(id);
    try {
      const payload = await F.request(`/drivers/${encodeURIComponent(id)}`);
      currentDriver = payload.driver || payload;
      document.getElementById('latInput').value = currentDriver.currentLatitude ?? '';
      document.getElementById('lngInput').value = currentDriver.currentLongitude ?? '';
      renderDriver();
      await loadJobs();
    } catch (error) {
      currentDriver = null;
      jobs = [];
      driverCard.innerHTML = `
        <p class="empty">โหลดข้อมูลคนขับ ${F.escapeHtml(id)} ไม่สำเร็จ</p>
        <p class="muted small">${F.escapeHtml(error.message)}</p>
      `;
      jobsBox.innerHTML = `<p class="empty">ยังไม่มีงาน</p>`;
      F.toast(error.message, 'error');
    }
  }

  function actionButtons(driver) {
    const statuses = ['AVAILABLE', 'ON_BREAK', 'OFFLINE'];
    return statuses
      .map((status) => {
        const disabled = driver.status === status ? 'disabled' : '';
        return `<button class="btn-small ${status === 'AVAILABLE' ? 'btn-primary' : ''}" data-status="${status}" ${disabled}>${F.driverLabel(status)}</button>`;
      })
      .join('');
  }

  function renderDriver() {
    const driver = currentDriver;
    if (!driver) return;
    driverCard.innerHTML = `
      <div class="row" style="justify-content: space-between; margin-bottom: 10px">
        <div>
          <div class="stat-value" style="font-size: 20px">${F.escapeHtml(driver.name || driver.id)}</div>
          <div class="mono muted small">${F.escapeHtml(driver.id)}</div>
        </div>
        ${F.driverBadge(driver.status)}
      </div>
      <dl class="kv">
        <dt>รถ / ทะเบียน</dt><dd>${F.escapeHtml(driver.vehicle || '-')} · ${F.escapeHtml(driver.licensePlate || '-')}</dd>
        <dt>โทรศัพท์</dt><dd>${F.escapeHtml(driver.phone || '-')}</dd>
        <dt>ความจุต่อชุด</dt><dd>${driver.assignedOrders.length} / ${driver.maxOrdersPerBatch}</dd>
        <dt>งานสะสม</dt><dd>${driver.totalDeliveries ?? 0} งาน</dd>
        <dt>เรตติ้ง</dt><dd>${Number(driver.rating || 0).toFixed(1)} / 5</dd>
        <dt>อัปเดตล่าสุด</dt><dd>${F.time(driver.lastLocationUpdate)}</dd>
      </dl>
      <div class="row" style="margin-top: 12px">${actionButtons(driver)}</div>
      <p class="muted small" style="margin-bottom: 0">
        สถานะ BUSY ถูกจัดการโดยระบบอัตโนมัติ และเปลี่ยนสถานะไม่ได้ขณะมีงานค้าง
      </p>
    `;

    driverCard.querySelectorAll('[data-status]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const payload = await F.request(`/drivers/${encodeURIComponent(driver.id)}`, {
            method: 'PATCH',
            body: { status: button.dataset.status }
          });
          currentDriver = payload.driver || payload;
          renderDriver();
          F.toast('อัปเดตสถานะแล้ว', 'success');
        } catch (error) {
          F.toast(error.message, 'error');
          button.disabled = false;
        }
      });
    });
  }

  async function loadJobs() {
    if (!currentDriver) return;
    const ids = currentDriver.assignedOrders || [];
    if (ids.length === 0) {
      jobs = [];
      jobsBox.innerHTML = `<p class="empty">ยังไม่มีงานที่ได้รับมอบหมาย</p>`;
      return;
    }
    try {
      const orders = await Promise.all(
        ids.map((id) =>
          F.request(`/orders/${encodeURIComponent(id)}`)
            .then((payload) => payload.order || payload)
            .catch(() => null)
        )
      );
      jobs = orders.filter(Boolean);
      renderJobs();
    } catch (error) {
      F.toast(error.message, 'error');
    }
  }

  function nextAction(order) {
    const map = {
      ASSIGNED: ['PICKED_UP', 'รับอาหารแล้ว'],
      PICKED_UP: ['IN_DELIVERY', 'เริ่มจัดส่ง'],
      IN_DELIVERY: ['DELIVERED', 'ส่งสำเร็จ']
    };
    const action = map[order.status];
    if (!action) return '';
    return `<button class="btn-primary btn-small" data-next="${action[0]}" data-order="${F.escapeHtml(order.id)}">${action[1]}</button>`;
  }

  function renderJobs() {
    if (jobs.length === 0) {
      jobsBox.innerHTML = `<p class="empty">ยังไม่มีงานที่ได้รับมอบหมาย</p>`;
      return;
    }
    jobsBox.innerHTML = jobs
      .map(
        (order) => `
        <div class="order-card" style="margin-bottom: 10px">
          <div class="order-card-head">
            <span class="mono">${F.escapeHtml(order.id)}</span>
            ${F.orderBadge(order.status)}
          </div>
          <dl class="kv">
            <dt>ลูกค้า</dt><dd>${F.escapeHtml(order.customer.name)} · ${F.escapeHtml(order.customer.phone)}</dd>
            <dt>ที่อยู่</dt><dd>${F.escapeHtml(order.customer.address)}</dd>
            <dt>ยอดเก็บเงิน</dt><dd>${F.money(order.totalAmount)}</dd>
            <dt>หมายเหตุ</dt><dd>${F.escapeHtml(order.notes || '-')}</dd>
          </dl>
          <div class="row">${nextAction(order)}</div>
        </div>`
      )
      .join('');

    jobsBox.querySelectorAll('[data-next]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await F.request(`/orders/${encodeURIComponent(button.dataset.order)}/status`, {
            method: 'PATCH',
            body: { status: button.dataset.next }
          });
          F.toast('อัปเดตสถานะงานแล้ว', 'success');
          await loadDriver();
        } catch (error) {
          F.toast(error.message, 'error');
          button.disabled = false;
        }
      });
    });
  }

  document.getElementById('loadDriver').addEventListener('click', loadDriver);
  idInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      loadDriver();
    }
  });
  document.getElementById('refreshJobs').addEventListener('click', loadJobs);

  document.getElementById('locateButton').addEventListener('click', () => {
    if (!navigator.geolocation) {
      F.toast('อุปกรณ์นี้ไม่รองรับ geolocation', 'error');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        document.getElementById('latInput').value = position.coords.latitude.toFixed(6);
        document.getElementById('lngInput').value = position.coords.longitude.toFixed(6);
        F.toast('ดึงตำแหน่งแล้ว กดบันทึกเพื่อส่งเข้าระบบ', 'success');
      },
      (error) => F.toast(`ดึงตำแหน่งไม่สำเร็จ: ${error.message}`, 'error'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  document.getElementById('saveLocation').addEventListener('click', async () => {
    if (!currentDriver) {
      F.toast('โหลดข้อมูลคนขับก่อน', 'error');
      return;
    }
    const latitude = F.parseNumber(document.getElementById('latInput').value, NaN);
    const longitude = F.parseNumber(document.getElementById('lngInput').value, NaN);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      F.toast('กรุณากรอกพิกัดให้ถูกต้อง', 'error');
      return;
    }
    try {
      const payload = await F.request(`/drivers/${encodeURIComponent(currentDriver.id)}`, {
        method: 'PATCH',
        body: { currentLatitude: latitude, currentLongitude: longitude }
      });
      currentDriver = payload.driver || payload;
      renderDriver();
      F.toast('บันทึกตำแหน่งแล้ว', 'success');
    } catch (error) {
      F.toast(error.message, 'error');
    }
  });

  document.getElementById('liveBadge').textContent = 'realtime: กำลังเชื่อมต่อ...';
  const socket = F.connectSocket({
    connect: () => {
      liveBadge.className = 'badge status-AVAILABLE';
      liveBadge.textContent = 'realtime: เชื่อมต่อแล้ว';
    },
    disconnect: () => {
      liveBadge.className = 'badge status-FAILED';
      liveBadge.textContent = 'realtime: ขาดการเชื่อมต่อ';
    },
    'driver:updated': (driver) => {
      if (currentDriver && driver.id === currentDriver.id) {
        currentDriver = driver;
        renderDriver();
        loadJobs();
      }
    },
    'batch:assigned': () => {
      if (currentDriver) loadDriver();
    },
    'order:status': () => {
      if (currentDriver) loadJobs();
    }
  });
  if (!socket) {
    liveBadge.className = 'badge status-PENDING';
    liveBadge.textContent = 'realtime: ไม่พร้อมใช้งาน';
  }

  loadDriver();
  setInterval(() => {
    if (currentDriver) loadJobs();
  }, 20000);
})();
