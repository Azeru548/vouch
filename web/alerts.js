const filterSelect = document.querySelector('#alerts-filter');
const status = document.querySelector('#alerts-status');
const list = document.querySelector('#alerts-list');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function card(alert) {
  const batches = alert.batches.length > 0 ? alert.batches.map(escapeHtml).join(', ') : 'see alert';
  const kind = alert.alert_type === 'recall' ? 'Recall' : 'Safety warning';
  return `<article class="alert-card ${alert.alert_type === 'recall' ? 'is-recall' : 'is-warning'}">
    <p class="alert-kind">${escapeHtml(kind)} No. ${escapeHtml(alert.alert_number)}</p>
    <h2>${escapeHtml(alert.product_name)}</h2>
    <p>${escapeHtml(alert.hazard)}</p>
    <ul class="alert-meta">
      ${alert.nafdac_number ? `<li><span>Reg. number</span><strong>${escapeHtml(alert.nafdac_number)}</strong></li>` : `<li><span>Reg. number</span><strong>None — unregistered product</strong></li>`}
      <li><span>Batches</span><strong>${batches}</strong></li>
      <li><span>Issued</span><strong>${escapeHtml(alert.alert_date)}</strong></li>
      ${alert.manufacturer ? `<li><span>Maker</span><strong>${escapeHtml(alert.manufacturer)}</strong></li>` : ''}
    </ul>
    <a class="btn btn-secondary" href="${escapeHtml(alert.source_url)}" target="_blank" rel="noopener">Read the official alert</a>
  </article>`;
}

async function loadAlerts() {
  const filter = filterSelect.value;
  status.textContent = 'Loading alerts…';
  list.innerHTML = '';
  const response = await fetch('/api/alerts');
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'alerts_failed');
  const shown = body.alerts.filter((alert) => filter === 'ALL' || alert.alert_type === filter);
  status.textContent = shown.length === 0
    ? 'No alerts in this view yet.'
    : `${shown.length} official alert${shown.length === 1 ? '' : 's'}, newest first.`;
  list.innerHTML = shown.map(card).join('');
}

filterSelect.addEventListener('change', () => {
  loadAlerts().catch((error) => {
    status.textContent = `Could not load alerts: ${error.message}`;
  });
});

loadAlerts().catch((error) => {
  status.textContent = `Could not load alerts: ${error.message}`;
});
