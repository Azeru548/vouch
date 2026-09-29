// Standalone flagged-products register. Reads the same known-fake library the
// verify flow matches against, so the page can never drift from what the app
// actually checks.

const CATEGORY_LABELS = {
  drug: 'Medicine',
  food: 'Food or drink',
  cosmetic: 'Cosmetic',
  device: 'Medical device',
  chemical: 'Chemical',
  other: 'Regulated product',
};

const list = document.getElementById('alerts-list');
const empty = document.getElementById('alerts-empty');
const countEl = document.getElementById('alerts-count');
const updatedEl = document.getElementById('alerts-updated');
const errorEl = document.getElementById('alerts-error');
const searchInput = document.getElementById('alerts-search-input');
const filterChips = [...document.querySelectorAll('.filter-chip')];

let alerts = [];
let filter = 'all';


function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function alertCard(alert) {
  // The API sends photos/aliases/batches already parsed as arrays.
  const photos = (Array.isArray(alert.photos) ? alert.photos : []).slice(0, 2);
  const aliases = Array.isArray(alert.aliases) ? alert.aliases : [];
  const batches = Array.isArray(alert.batches) ? alert.batches : [];
  const category = CATEGORY_LABELS[alert.category] || CATEGORY_LABELS.other;
  const number = alert.nafdac_number
    ? `<span class="alert-meta-item"><span class="k">Registration</span> ${escapeHtml(alert.nafdac_number)}</span>`
    : '';
  const batchLine = batches.length > 0
    ? `<span class="alert-meta-item"><span class="k">Batches</span> ${escapeHtml(batches.join(', '))}</span>`
    : '';
  const aliasLine = aliases.length > 0
    ? `<p class="alert-aliases">Also seen as: ${aliases.map(escapeHtml).join(' · ')}</p>`
    : '';
  const appearance = alert.appearance
    ? `<p class="alert-appearance"><span class="k">What to look for</span> ${escapeHtml(alert.appearance)}</p>`
    : '';
  const photoBlock = photos.length > 0
    ? `<div class="alert-photos">
        ${photos.map((src) => `<figure><img src="${escapeHtml(src)}" alt="Official NAFDAC photo of the flagged ${escapeHtml(alert.product_name)}" loading="lazy"><figcaption>NAFDAC reference photo</figcaption></figure>`).join('')}
      </div>`
    : '<p class="alert-no-photo">No official photo exists for this alert — compare using the written description above.</p>';

  return `<article class="alert-entry" data-category="${escapeHtml(alert.category || 'other')}">
    <div class="alert-entry-head">
      <span class="alert-chip">${escapeHtml(category)}</span>
      <span class="alert-number">Alert ${escapeHtml(alert.alert_number)}</span>
    </div>
    <h2>${escapeHtml(alert.product_name)}</h2>
    <p class="alert-hazard">${escapeHtml(alert.hazard || 'Flagged in a NAFDAC public alert.')}</p>
    ${aliasLine}
    <div class="alert-meta">
      ${number}
      ${batchLine}
    </div>
    ${appearance}
    ${photoBlock}
    <a class="alert-source" href="${escapeHtml(alert.source_url)}" target="_blank" rel="noopener">Read the official NAFDAC alert ↗</a>
  </article>`;
}

function applyFilters() {
  const term = searchInput.value.trim().toLowerCase();
  const visible = alerts.filter((alert) => {
    if (filter !== 'all' && (alert.category || 'other') !== filter) return false;
    if (!term) return true;
    const haystack = [
      alert.product_name,
      alert.brand_name,
      alert.alert_number,
      alert.nafdac_number,
      (Array.isArray(alert.aliases) ? alert.aliases : []).join(' '),
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(term);
  });

  list.innerHTML = visible.map(alertCard).join('');
  empty.classList.toggle('hidden', visible.length > 0);
  countEl.textContent = visible.length === alerts.length
    ? `${alerts.length} flagged product${alerts.length === 1 ? '' : 's'} on record`
    : `${visible.length} of ${alerts.length} flagged products shown`;
}

filterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    filter = chip.dataset.filter;
    filterChips.forEach((other) => {
      const active = other === chip;
      other.classList.toggle('selected', active);
      other.setAttribute('aria-pressed', String(active));
    });
    applyFilters();
  });
});

searchInput.addEventListener('input', applyFilters);

(async () => {
  try {
    const response = await fetch('/api/alerts');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    alerts = body.alerts || [];
    updatedEl.textContent = `Library synced from NAFDAC public alerts · ${alerts.length} entries`;
  } catch (error) {
    errorEl.textContent = 'The register could not be loaded. Refresh the page to try again.';
    errorEl.classList.remove('hidden');
  }
  applyFilters();
})();
