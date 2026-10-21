(function () {
  const KEY_STORAGE = 'fod.apiKey';
  const DRIVER_STORAGE = 'fod.driverId';

  const ORDER_LABELS = {
    PENDING: 'รอยืนยันร้าน',
    READY: 'ร้านพร้อมส่ง',
    ASSIGNED: 'มอบหมายแล้ว',
    PICKED_UP: 'รับอาหารแล้ว',
    IN_DELIVERY: 'กำลังส่ง',
    DELIVERED: 'ส่งสำเร็จ',
    CANCELLED: 'ยกเลิก',
    FAILED: 'ล้มเหลว'
  };

  const PAYMENT_LABELS = {
    PENDING: 'รอชำระ',
    PROCESSING: 'กำลังดำเนินการ',
    COMPLETED: 'ชำระแล้ว',
    FAILED: 'ชำระไม่สำเร็จ',
    REFUNDED: 'คืนเงินแล้ว'
  };

  const DRIVER_LABELS = {
    AVAILABLE: 'พร้อมรับงาน',
    BUSY: 'กำลังรับงาน',
    ON_BREAK: 'พัก',
    OFFLINE: 'ออฟไลน์'
  };

  const NEXT_STATUS = {
    PENDING: ['READY', 'CANCELLED', 'FAILED'],
    READY: ['CANCELLED', 'FAILED'],
    ASSIGNED: ['PICKED_UP', 'CANCELLED', 'FAILED'],
    PICKED_UP: ['IN_DELIVERY', 'CANCELLED', 'FAILED'],
    IN_DELIVERY: ['DELIVERED', 'FAILED'],
    DELIVERED: [],
    CANCELLED: [],
    FAILED: []
  };

  const FLOW = ['PENDING', 'READY', 'ASSIGNED', 'PICKED_UP', 'IN_DELIVERY', 'DELIVERED'];

  function getKey() {
    return localStorage.getItem(KEY_STORAGE) || '';
  }

  function setKey(value) {
    const trimmed = String(value || '').trim();
    if (trimmed) localStorage.setItem(KEY_STORAGE, trimmed);
    else localStorage.removeItem(KEY_STORAGE);
    document.querySelectorAll('[data-key-state]').forEach((node) => {
      node.textContent = trimmed ? 'ใช้ API key แล้ว' : 'ยังไม่ได้ใส่ API key';
      node.className = trimmed ? 'badge status-AVAILABLE' : 'badge status-PENDING';
    });
  }

  function getDriverId() {
    return localStorage.getItem(DRIVER_STORAGE) || '';
  }

  function setDriverId(value) {
    const trimmed = String(value || '').trim();
    if (trimmed) localStorage.setItem(DRIVER_STORAGE, trimmed);
    else localStorage.removeItem(DRIVER_STORAGE);
  }

  async function request(path, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    const key = getKey();
    if (key) headers['x-api-key'] = key;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const response = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && payload.error
          ? payload.error
          : typeof payload === 'string' && payload
            ? payload
            : `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  function money(value) {
    return Number(value || 0).toLocaleString('th-TH', {
      style: 'currency',
      currency: 'THB',
      maximumFractionDigits: 2
    });
  }

  function time(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString('th-TH', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function minutes(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) return '-';
    if (number < 60) return `${Math.round(number)} นาที`;
    const hours = Math.floor(number / 60);
    return `${hours} ชม. ${Math.round(number % 60)} นาที`;
  }

  function orderLabel(status) {
    return ORDER_LABELS[status] || status || '-';
  }

  function paymentLabel(status) {
    return PAYMENT_LABELS[status] || status || '-';
  }

  function driverLabel(status) {
    return DRIVER_LABELS[status] || status || '-';
  }

  function orderBadge(status) {
    return `<span class="badge status-${escapeHtml(status)}">${escapeHtml(orderLabel(status))}</span>`;
  }

  function paymentBadge(status) {
    const css = status === 'COMPLETED' ? 'DELIVERED' : status === 'FAILED' ? 'FAILED' : 'PENDING';
    return `<span class="badge status-${css}">${escapeHtml(paymentLabel(status))}</span>`;
  }

  function driverBadge(status) {
    return `<span class="badge status-${escapeHtml(status)}">${escapeHtml(driverLabel(status))}</span>`;
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function nextStatuses(status) {
    return NEXT_STATUS[status] || [];
  }

  function progressIndex(status) {
    if (status === 'CANCELLED' || status === 'FAILED') return -1;
    return FLOW.indexOf(status);
  }

  function toast(message, kind) {
    let node = document.querySelector('.toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'toast';
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.className = `toast show ${kind || ''}`.trim();
    clearTimeout(node._timer);
    node._timer = setTimeout(() => {
      node.classList.remove('show');
    }, 3800);
  }

  function bindKeyBar() {
    const input = document.querySelector('[data-api-key]');
    const save = document.querySelector('[data-save-key]');
    if (!input) return;
    input.value = getKey();
    setKey(getKey());
    function commit() {
      setKey(input.value);
      toast(input.value.trim() ? 'บันทึก API key แล้ว' : 'ล้าง API key แล้ว', 'success');
    }
    if (save) save.addEventListener('click', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });
  }

  function connectSocket(handlers) {
    if (typeof io !== 'function') return null;
    const key = getKey();
    const socket = io('/', { auth: key ? { token: key } : {} });
    Object.entries(handlers || {}).forEach(([event, handler]) => {
      socket.on(event, handler);
    });
    return socket;
  }

  function debounce(fn, delay) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), delay || 250);
    };
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function parseNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  window.FOD = {
    getKey,
    setKey,
    getDriverId,
    setDriverId,
    request,
    money,
    time,
    minutes,
    orderLabel,
    paymentLabel,
    driverLabel,
    orderBadge,
    paymentBadge,
    driverBadge,
    escapeHtml,
    nextStatuses,
    progressIndex,
    flow: FLOW,
    toast,
    bindKeyBar,
    connectSocket,
    debounce,
    uuid,
    parseNumber
  };

  const swSecure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if (swSecure && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    });
  }
})();
