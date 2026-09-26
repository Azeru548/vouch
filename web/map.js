const map = L.map('report-map', { worldCopyJump: true }).setView([6.5, 8], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors',
}).addTo(map);

const countrySelect = document.querySelector('#map-country');
const status = document.querySelector('#map-status');
const areas = document.querySelector('#map-areas');
let layerGroup = L.featureGroup().addTo(map);

const params = new URLSearchParams(window.location.search);
const initialCountry = params.get('country');
if (initialCountry && ['ALL', 'NG', 'KE'].includes(initialCountry.toUpperCase())) {
  countrySelect.value = initialCountry.toUpperCase();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function clusterKey(report) {
  return `${report.country}|${report.location_area.toLowerCase()}`;
}

async function loadMap() {
  const country = countrySelect.value;
  status.textContent = 'Loading reports…';
  areas.innerHTML = '';
  layerGroup.clearLayers();

  const response = await fetch(`/api/reports?country=${country}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'reports_failed');

  const located = body.reports.filter((report) => Number.isFinite(report.latitude) && Number.isFinite(report.longitude));
  const unlocated = body.reports.length - located.length;
  const clusters = new Map();
  for (const report of located) {
    const key = clusterKey(report);
    if (!clusters.has(key)) {
      clusters.set(key, {
        country: report.country,
        area: report.location_area,
        latitude: report.latitude,
        longitude: report.longitude,
        count: 0,
        seed: false,
        real: false,
        numbers: new Set(),
      });
    }
    const cluster = clusters.get(key);
    cluster.count += 1;
    cluster.latitude = (cluster.latitude * (cluster.count - 1) + report.latitude) / cluster.count;
    cluster.longitude = (cluster.longitude * (cluster.count - 1) + report.longitude) / cluster.count;
    if (report.is_seed) cluster.seed = true;
    else cluster.real = true;
    cluster.numbers.add(report.nafdac_number);
  }

  const sorted = [...clusters.values()].sort((a, b) => b.count - a.count);
  for (const cluster of sorted) {
    const marker = L.circleMarker([cluster.latitude, cluster.longitude], {
      radius: 8 + Math.min(20, cluster.count * 3),
      color: cluster.country === 'KE' ? '#1d4fa1' : '#35318f',
      weight: 3,
      dashArray: cluster.seed && !cluster.real ? '6 4' : undefined,
      fillColor: cluster.seed && !cluster.real ? '#f5c542' : cluster.country === 'KE' ? '#1d4fa1' : '#35318f',
      fillOpacity: 0.55,
    });
    marker.bindPopup(`
      <strong>${escapeHtml(cluster.area)}</strong><br>
      ${cluster.country === 'KE' ? 'Kenya' : 'Nigeria'} · ${cluster.count} report${cluster.count === 1 ? '' : 's'}<br>
      Numbers: ${escapeHtml([...cluster.numbers].slice(0, 4).join(', '))}<br>
      ${cluster.seed ? 'Includes seed/demo data.' : 'Community reports.'}
    `);
    marker.addTo(layerGroup);
  }

  if (sorted.length > 0) {
    map.fitBounds(layerGroup.getBounds().pad(0.35));
  } else {
    map.setView(country === 'KE' ? [-1.2921, 36.8219] : [9.0579, 7.4951], 5);
  }

  status.textContent = `${body.reports.length} reports shown (${sorted.length} mapped clusters${unlocated > 0 ? `, ${unlocated} without coordinates` : ''}).`;
  areas.innerHTML = sorted.map((cluster) => `
    <li>
      <strong>${escapeHtml(cluster.area)}</strong>
      <span>${cluster.country} · ${cluster.count} reports · ${cluster.seed && !cluster.real ? 'seed/demo' : 'community'}</span>
    </li>
  `).join('');
}

countrySelect.addEventListener('change', () => {
  loadMap().catch((error) => {
    status.textContent = `Could not load reports: ${error.message}`;
  });
});

loadMap().catch((error) => {
  status.textContent = `Could not load reports: ${error.message}`;
});
