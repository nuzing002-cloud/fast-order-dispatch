(function () {
  const F = window.FOD;
  F.bindKeyBar();

  const idInput = document.getElementById('driverIdInput');
  const driverCard = document.getElementById('driverCard');
  const jobsBox = document.getElementById('jobs');
  const liveBadge = document.getElementById('liveBadge');
  const earningsBox = document.getElementById('earningsBox');
  const enablePushButton = document.getElementById('enablePush');
  const pushState = document.getElementById('pushState');
  const startLocationTrackingButton = document.getElementById('startLocationTracking');
  const stopLocationTrackingButton = document.getElementById('stopLocationTracking');
  const locationTrackingState = document.getElementById('locationTrackingState');

  idInput.value = F.getDriverId() || '1388246780';

  let currentDriver = null;
  let jobs = [];
  let locationWatchId = null;
  let locationTrackingDriverId = null;
  let locationWatchGeneration = 0;
  let pendingLocation = null;
  let locationUpdateTimer = null;
  let locationUpdateInFlight = false;
  let lastLocationUpdateAt = 0;
  const locationUpdateIntervalMs = 15000;

  function setLocationTrackingState(text, status) {
    locationTrackingState.textContent = text;
    locationTrackingState.className = `badge status-${status}`;
  }

  function stopLocationTracking() {
    locationWatchGeneration += 1;
    if (locationWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(locationWatchId);
    }
    locationWatchId = null;
    locationTrackingDriverId = null;
    pendingLocation = null;
    if (locationUpdateTimer !== null) {
      clearTimeout(locationUpdateTimer);
      locationUpdateTimer = null;
    }
    startLocationTrackingButton.disabled = false;
    stopLocationTrackingButton.disabled = true;
    setLocationTrackingState('หยุดติดตามแล้ว', 'PENDING');
  }

  function scheduleLocationUpdate() {
    if (
      locationUpdateTimer !== null ||
      locationUpdateInFlight ||
      !pendingLocation ||
      locationWatchId === null
    ) {
      return;
    }

    const delay = Math.max(0, locationUpdateIntervalMs - (Date.now() - lastLocationUpdateAt));
    locationUpdateTimer = setTimeout(async () => {
      locationUpdateTimer = null;
      if (!pendingLocation || locationWatchId === null || !currentDriver) return;

      const targetDriverId = locationTrackingDriverId;
      const location = pendingLocation;
      pendingLocation = null;
      locationUpdateInFlight = true;

      try {
        const payload = await F.request(`/drivers/${encodeURIComponent(targetDriverId)}`, {
          method: 'PATCH',
          body: {
            currentLatitude: location.latitude,
            currentLongitude: location.longitude
          }
        });
        lastLocationUpdateAt = Date.now();
        if (currentDriver?.id === targetDriverId && locationTrackingDriverId === targetDriverId) {
          currentDriver = payload.driver || payload;
          renderDriver();
          setLocationTrackingState('กำลังติดตาม · บันทึกล่าสุด ' + F.time(currentDriver.lastLocationUpdate), 'AVAILABLE');
        }
      } catch (error) {
        lastLocationUpdateAt = Date.now();
        if (currentDriver?.id === targetDriverId && locationTrackingDriverId === targetDriverId) {
          F.toast(`บันทึกตำแหน่งอัตโนมัติไม่สำเร็จ: ${error.message}`, 'error');
          setLocationTrackingState('ติดตามอยู่ · บันทึกไม่สำเร็จ', 'FAILED');
        }
      } finally {
        locationUpdateInFlight = false;
        scheduleLocationUpdate();
      }
    }, delay);
  }

  function handleTrackedPosition(position, targetDriverId, generation) {
    if (
      locationWatchId === null ||
      locationWatchGeneration !== generation ||
      locationTrackingDriverId !== targetDriverId ||
      currentDriver?.id !== targetDriverId
    ) {
      return;
    }

    const { latitude, longitude, accuracy } = position.coords;
    const age = Date.now() - position.timestamp;
    if (
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1000 ||
      !Number.isFinite(position.timestamp) || age < 0 || age > 30000
    ) {
      setLocationTrackingState('ได้รับพิกัดเก่าหรือไม่แม่นยำพอ', 'FAILED');
      return;
    }

    document.getElementById('latInput').value = latitude.toFixed(6);
    document.getElementById('lngInput').value = longitude.toFixed(6);
    pendingLocation = { latitude, longitude };
    setLocationTrackingState('ติดตามอยู่ · ความแม่นยำประมาณ ' + Math.round(accuracy) + ' ม.', 'AVAILABLE');
    scheduleLocationUpdate();
  }

  function startLocationTracking() {
    if (!currentDriver) {
      F.toast('โหลดข้อมูลคนขับก่อนเริ่มติดตาม', 'error');
      return;
    }
    if (!window.isSecureContext || !navigator.geolocation) {
      F.toast('การติดตามตำแหน่งต้องใช้ HTTPS หรือ localhost และเบราว์เซอร์ที่รองรับ', 'error');
      return;
    }

    stopLocationTracking();
    const targetDriverId = currentDriver.id;
    const generation = locationWatchGeneration;
    locationTrackingDriverId = targetDriverId;
    lastLocationUpdateAt = 0;
    locationWatchId = navigator.geolocation.watchPosition(
      (position) => handleTrackedPosition(position, targetDriverId, generation),
      (error) => {
        if (locationWatchGeneration !== generation) return;
        const messages = {
          1: 'ไม่ได้รับอนุญาตให้เข้าถึงตำแหน่ง',
          2: 'ระบุตำแหน่งไม่ได้',
          3: 'หมดเวลารอตำแหน่ง'
        };
        setLocationTrackingState(messages[error.code] || 'เกิดข้อผิดพลาดจากตำแหน่ง', 'FAILED');
        F.toast(messages[error.code] || `ติดตามตำแหน่งไม่สำเร็จ: ${error.message}`, 'error');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
    startLocationTrackingButton.disabled = true;
    stopLocationTrackingButton.disabled = false;
    setLocationTrackingState('กำลังรอพิกัดจากอุปกรณ์', 'PENDING');
  }

  startLocationTrackingButton.addEventListener('click', startLocationTracking);
  stopLocationTrackingButton.addEventListener('click', stopLocationTracking);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && locationWatchId !== null) {
      stopLocationTracking();
      setLocationTrackingState('หยุดแล้วเมื่อออกจากหน้า', 'PENDING');
    }
  });
  window.addEventListener('pagehide', stopLocationTracking);

  async function loadDriver() {
    const id = idInput.value.trim();
    if (!id) {
      F.toast('กรุณากรอก Driver ID', 'error');
      return;
    }
    if (locationTrackingDriverId && locationTrackingDriverId !== id) {
      stopLocationTracking();
    }
    F.setDriverId(id);
    try {
      const payload = await F.request(`/drivers/${encodeURIComponent(id)}`);
      currentDriver = payload.driver || payload;
      document.getElementById('latInput').value = currentDriver.currentLatitude ?? '';
      document.getElementById('lngInput').value = currentDriver.currentLongitude ?? '';
      renderDriver();
      await Promise.all([loadJobs(), loadEarnings()]);
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
      <div class="row" style="margin-top: 12px">
        ${actionButtons(driver)}
        <button class="btn-small" data-accept-toggle>
          ${driver.acceptsNewOrders === false ? 'เปิดรับงานใหม่' : 'หยุดรับงานใหม่'}
        </button>
      </div>
      <p class="muted small" style="margin-bottom: 0">
        สถานะ BUSY ถูกจัดการโดยระบบอัตโนมัติ และเปลี่ยนสถานะไม่ได้ขณะมีงานค้าง
        · ${driver.acceptsNewOrders === false ? 'ขณะนี้หยุดรับงานใหม่' : 'พร้อมรับงานใหม่'}
      </p>
    `;

    driverCard.querySelector('[data-accept-toggle]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const payload = await F.request(`/drivers/${encodeURIComponent(driver.id)}`, {
          method: 'PATCH',
          body: { acceptsNewOrders: driver.acceptsNewOrders === false }
        });
        currentDriver = payload.driver || payload;
        renderDriver();
        F.toast(currentDriver.acceptsNewOrders === false ? 'หยุดรับงานใหม่แล้ว' : 'เปิดรับงานใหม่แล้ว', 'success');
      } catch (error) {
        F.toast(error.message, 'error');
        button.disabled = false;
      }
    });

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

  function declineAction(order) {
    if (order.status !== 'ASSIGNED') return '';
    return `<button class="btn-small btn-danger" data-decline="${F.escapeHtml(order.id)}">ปฏิเสธงาน</button>`;
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
          <div class="row">${nextAction(order)} ${declineAction(order)}</div>
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

    jobsBox.querySelectorAll('[data-decline]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!currentDriver) return;
        if (!confirm('ปฏิเสธงานนี้? งานจะถูกส่งคืนคิวและไม่เสนอให้คุณอีก')) {
          button.disabled = false;
          return;
        }
        button.disabled = true;
        try {
          await F.request(`/orders/${encodeURIComponent(button.dataset.decline)}/decline`, {
            method: 'POST',
            body: { driverId: currentDriver.id }
          });
          F.toast('ปฏิเสธงานแล้ว งานถูกส่งคืนคิว', 'success');
          await loadDriver();
        } catch (error) {
          F.toast(error.message, 'error');
          button.disabled = false;
        }
      });
    });
  }

  async function loadEarnings() {
    if (!currentDriver) return;
    try {
      const summary = await F.request(`/drivers/${encodeURIComponent(currentDriver.id)}/earnings`);
      const recent = (summary.earnings || []).slice(-5).reverse();
      earningsBox.innerHTML = `
        <dl class="kv">
          <dt>รอจ่าย</dt><dd>${F.money(summary.pendingAmount)}</dd>
          <dt>จ่ายแล้ว</dt><dd>${F.money(summary.paidAmount)}</dd>
          <dt>รวมทั้งหมด</dt><dd>${F.money(summary.totalAmount)}</dd>
        </dl>
        ${
          recent.length
            ? `<div class="card-list">${recent
                .map(
                  (earning) => `
                  <div class="order-card">
                    <div class="order-card-head">
                      <span class="mono">${F.escapeHtml(earning.orderId.slice(-10))}</span>
                      <span class="badge ${earning.status === 'PAID' ? 'status-DELIVERED' : 'status-PENDING'}">${earning.status === 'PAID' ? 'จ่ายแล้ว' : 'รอจ่าย'}</span>
                    </div>
                    <span class="muted small">${F.money(earning.amount)} · ${F.time(earning.createdAt)}</span>
                  </div>`
                )
                .join('')}</div>`
            : '<p class="muted small">ยังไม่มีรายได้</p>'
        }`;
    } catch (error) {
      earningsBox.innerHTML = `<p class="empty">โหลดรายได้ไม่สำเร็จ: ${F.escapeHtml(error.message)}</p>`;
    }
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

  document.getElementById('refreshEarnings').addEventListener('click', loadEarnings);

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
  }

  function setPushState(text, status) {
    pushState.textContent = text;
    pushState.className = `badge status-${status}`;
  }

  async function refreshPushState() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushState('เบราว์เซอร์ไม่รองรับ', 'FAILED');
      enablePushButton.disabled = true;
      return;
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      setPushState(subscription ? 'เปิดแจ้งเตือนแล้ว' : 'ยังไม่เปิด', subscription ? 'AVAILABLE' : 'PENDING');
    } catch (_error) {
      setPushState('ตรวจสอบไม่สำเร็จ', 'PENDING');
    }
  }

  enablePushButton.addEventListener('click', async () => {
    if (!currentDriver) {
      F.toast('โหลดข้อมูลคนขับก่อน', 'error');
      return;
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      F.toast('เบราว์เซอร์นี้ไม่รองรับ push notification', 'error');
      return;
    }
    enablePushButton.disabled = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        F.toast('ยังไม่ได้รับอนุญาตให้แจ้งเตือน', 'error');
        return;
      }
      const { publicKey } = await F.request('/push/public-key');
      if (!publicKey) throw new Error('เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า push');
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        }));
      await F.request('/push/subscribe', {
        method: 'POST',
        body: { driverId: currentDriver.id, subscription: subscription.toJSON() }
      });
      setPushState('เปิดแจ้งเตือนแล้ว', 'AVAILABLE');
      F.toast('เปิดแจ้งเตือนงานใหม่แล้ว', 'success');
    } catch (error) {
      F.toast(error.message, 'error');
      await refreshPushState();
    } finally {
      enablePushButton.disabled = false;
    }
  });

  refreshPushState();

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
