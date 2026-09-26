const $ = (selector) => document.querySelector(selector);

const els = {
  cameraBtn: $('#btn-camera'),
  fileInput: $('#file-input'),
  clearBtn: $('#btn-clear-image'),
  previewWrap: $('#preview-wrap'),
  preview: $('#preview'),
  ocrStatus: $('#ocr-status'),
  visionBanner: $('#vision-banner'),
  form: $('#verify-form'),
  country: $('#in-country'),
  nafdac: $('#in-nafdac'),
  name: $('#in-name'),
  mfr: $('#in-mfr'),
  confirmHint: $('#confirm-hint'),
  result: $('#result'),
  verifyButton: $('#verify-button'),
  verifyLabel: $('#verify-label'),
};

const NAFDAC_RE = /^[A-Z0-9]{1,3}-\d{3,6}$/i;
const PPB_RE = /^[A-Z0-9][A-Z0-9/.-]{2,31}$/i;

function sessionId() {
  try {
    const stored = window.localStorage.getItem('vouch-session-id');
    if (stored) return stored;
  } catch {}
  const fresh = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    window.localStorage.setItem('vouch-session-id', fresh);
  } catch {}
  return fresh;
}

let visionEnabled = false;
let activeCamera = null;

fetch('/api/config')
  .then((response) => response.json())
  .then((config) => {
    visionEnabled = config.vision_enabled;
    if (!visionEnabled) {
      els.visionBanner.textContent = 'Photo reading is not configured. You can still attach a photo and type the details manually.';
      els.visionBanner.classList.remove('hidden');
    }
  })
  .catch(() => {});

els.cameraBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
    });
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-label', 'Camera preview');
    await video.play();

    const stage = document.createElement('div');
    stage.className = 'camera-stage';

    const actions = document.createElement('div');
    actions.className = 'camera-actions';

    const shutter = document.createElement('button');
    shutter.className = 'btn btn-primary';
    shutter.type = 'button';
    shutter.textContent = 'Capture photo';

    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';

    actions.append(shutter, cancel);
    stage.append(video, actions);
    els.previewWrap.before(stage);
    activeCamera = { stage, track };
    cancel.focus();

    const cleanup = () => {
      track.stop();
      video.srcObject = null;
      stage.remove();
      if (activeCamera?.stage === stage) activeCamera = null;
    };

    cancel.addEventListener('click', cleanup);
    shutter.addEventListener('click', () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      cleanup();
      handleImage(canvas.toDataURL('image/jpeg', 0.9));
    });
  } catch (error) {
    const reason = error?.name === 'NotAllowedError' ? 'camera permission was denied' : 'the camera could not be opened';
    setOcrStatus(`Could not start the camera because ${reason}. Use “Upload image” instead.`, true);
    els.fileInput.focus();
  }
});

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    setOcrStatus('Choose an image file such as JPG, PNG, or HEIC.', true);
    els.fileInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => handleImage(reader.result);
  reader.onerror = () => setOcrStatus('That image could not be read. Try another file.', true);
  reader.readAsDataURL(file);
});

els.clearBtn.addEventListener('click', clearImage);

function clearImage() {
  if (activeCamera) {
    activeCamera.track.stop();
    activeCamera.stage.remove();
    activeCamera = null;
  }
  els.fileInput.value = '';
  els.preview.removeAttribute('src');
  els.previewWrap.classList.add('hidden');
  els.previewWrap.classList.remove('is-reading');
  els.ocrStatus.classList.add('hidden');
  els.cameraBtn.focus();
}

async function optimizeImage(dataUrl) {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = dataUrl;
  });

  const maxDimension = 1600;
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function handleImage(dataUrl) {
  setOcrStatus('<span class="spinner spinner-dark"></span>Preparing photo…');
  els.previewWrap.classList.remove('hidden');
  els.previewWrap.classList.add('is-reading');

  let optimizedImage;
  try {
    optimizedImage = await optimizeImage(dataUrl);
  } catch {
    els.previewWrap.classList.remove('is-reading');
    setOcrStatus('That image could not be prepared. Try another file.', true);
    return;
  }

  els.preview.src = optimizedImage;
  document.getElementById('report-photo')?.removeAttribute('disabled');

  if (!visionEnabled) {
    els.previewWrap.classList.remove('is-reading');
    setOcrStatus('Photo attached. Type the NAFDAC number below to check it.', true);
    els.nafdac.focus();
    return;
  }

  setOcrStatus('<span class="spinner spinner-dark"></span>Reading the NAFDAC number…');

  try {
    const response = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: optimizedImage }),
    });
    const result = await response.json();

    if (!response.ok) {
      setOcrStatus(
        result.error === 'vision_not_configured'
          ? 'Photo reading is not configured. Type the NAFDAC number below.'
          : 'Photo reading could not finish. Type the NAFDAC number below.',
        true,
      );
      els.nafdac.focus();
      return;
    }

    if (result.usable) {
      els.nafdac.value = result.nafdac_number;
      setOcrStatus(`Read NAFDAC number “${result.nafdac_number}”. Check it, then enter the product name.`);
      els.nafdac.focus();
      els.nafdac.select();
      return;
    }

    els.nafdac.value = result.nafdac_number || '';
    if (result.nafdac_number && !result.format_valid) {
      setOcrStatus(`Read “${result.nafdac_number}”, but its format is not valid. Correct it below.`, true);
    } else {
      setOcrStatus('No clear NAFDAC number was found. Enter it below.', true);
    }
    els.confirmHint.textContent = 'Correct the number if needed, then enter the exact product name.';
    els.nafdac.focus();
  } catch {
    setOcrStatus('Photo reading could not be reached. Type the NAFDAC number below.', true);
    els.nafdac.focus();
  } finally {
    els.previewWrap.classList.remove('is-reading');
  }
}

function setOcrStatus(html, warn = false) {
  els.ocrStatus.innerHTML = html;
  els.ocrStatus.classList.remove('hidden');
  els.ocrStatus.classList.toggle('warn', warn);
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitVerify();
});

async function submitVerify() {
  const nafdac = els.nafdac.value.trim();
  const productName = els.name.value.trim();
  const manufacturer = els.mfr.value.trim();
  const country = els.country.value;

  if (!els.form.reportValidity()) return;
  const validNumber = country === 'KE' ? PPB_RE.test(nafdac) : NAFDAC_RE.test(nafdac);
  if (!validNumber) {
    showLocalError(country === 'KE'
      ? 'Enter the Kenya PPB registration number exactly as printed on the pack.'
      : 'Enter the NAFDAC number in the format shown on the pack, such as A11-0009.');
    els.nafdac.focus();
    return;
  }
  if (!productName) {
    showLocalError('Enter the product name exactly as printed on the pack.');
    els.name.focus();
    return;
  }

  setResult('<div class="result r-loading"><div class="result-head"><span class="spinner"></span><h2>Checking the registry…</h2></div><p class="result-message">Comparing the product details with the local NAFDAC snapshot.</p></div>');
  els.verifyButton.disabled = true;
  els.verifyLabel.textContent = 'Checking registration…';

  const query = new URLSearchParams({ nafdac, product_name: productName, country });
  if (manufacturer) query.set('manufacturer', manufacturer);

  try {
    const response = await fetch(`/verify?${query}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'verification_failed');
    paint(result, { nafdac, productName, manufacturer, country });
  } catch (error) {
    showServiceError(error);
  } finally {
    els.verifyButton.disabled = false;
    els.verifyLabel.textContent = 'Check registration';
  }
}

function showLocalError(message) {
  setResult(`<div class="result r-error"><div class="result-head"><h2>Check the product details</h2></div><p class="result-message">${escapeHtml(message)}</p></div>`);
}

function showServiceError(error) {
  setResult(`<div class="result r-error"><div class="result-head"><h2>Verification is temporarily unavailable</h2></div><p class="result-message">We could not complete the registry check. Please try again in a moment.</p><p class="result-detail">${escapeHtml(error.message)}</p></div>`);
}

function setResult(html) {
  els.result.innerHTML = html;
  els.result.classList.remove('hidden');
  els.result.focus({ preventScroll: true });
  els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function paint(result, input) {
  const treatments = {
    verified: {
      className: 'r-verified',
      badge: 'Registry match',
      title: 'This product is registered and active',
    },
    verified_inactive: {
      className: 'r-inactive',
      badge: 'Approval not active',
      title: 'Registered, but the approval is not active',
    },
    mismatch: {
      className: 'r-mismatch',
      badge: 'Details mismatch',
      title: 'This product could not be confirmed',
    },
    not_found: {
      className: 'r-notfound',
      badge: 'Not found',
      title: 'No matching registration was found',
    },
  };

  if (!treatments[result.status]) {
    showServiceError(new Error(`Unexpected response status: ${result.status}`));
    return;
  }
  const treatment = { ...treatments[result.status] };

  const record = result.matched || result.closest_match;
  const manualNapams = record?.source === 'napams_manual';
  if (manualNapams) {
    treatment.badge = 'NAPAMS cache';
    treatment.title = result.status === 'verified_inactive'
      ? 'This product was manually confirmed inactive on NAPAMS'
      : 'This product was manually confirmed on NAPAMS';
  }
  const parts = [];
  if (result.hazard) {
    parts.push(hazardBanner(result.hazard));
  }
  if (result.community_flag?.flagged) {
    parts.push(communityBanner(result.community_flag));
  }
  parts.push(
    `<div class="result-head"><span class="result-badge">${treatment.badge}</span><h2>${escapeHtml(treatment.title)}</h2></div>`,
  );

  if (result.status === 'not_found') {
    parts.push(
      '<p class="result-message">This number is not in our copy of the registry. Double-check it against the pack — if it matches, the product may be unregistered, or our copy may be out of date.</p>',
      `<ul class="result-meta">
        <li><span class="k">NAFDAC number</span><span class="v">${escapeHtml(input.nafdac)}</span></li>
        <li><span class="k">Product name entered</span><span class="v">${escapeHtml(input.productName)}</span></li>
      </ul>`,
    );
  } else {
    if (result.status === 'verified_inactive' && result.message) {
      parts.push(`<p class="result-message">${escapeHtml(result.message)}</p>`);
    }
    if (result.status === 'mismatch') {
      parts.push('<p class="result-message">A similar listing exists, but it does not confirm the details entered.</p>');
      if (result.reason === 'manufacturer_mismatch') {
        parts.push('<p class="result-warn-note">The product name matched, but the manufacturer did not. Check the spelling or remove the optional manufacturer field.</p>');
      }
    }
    const heading = result.status === 'mismatch' ? 'Closest registry listing' : 'Matched registry listing';
    parts.push(`<p class="result-label">${heading}</p>`, `<ul class="result-meta">${rowsFor(record)}</ul>`);
    if (typeof result.score === 'number') {
      parts.push(`<p class="result-score">Name match confidence: ${Math.max(0, Math.min(100, Math.round(result.score)))}%</p>`);
    }
  }

  if (input.country === 'NG' && (result.status === 'mismatch' || result.status === 'not_found')) {
    parts.push(napamsPanel(input));
  }
  if (result.status === 'mismatch' || result.status === 'not_found') {
    parts.push(reportPanel(input, result));
  }

  parts.push('<p class="result-footnote">This result reflects the local registry snapshot and does not assess product quality or authenticity beyond the available registration data.</p>');
  setResult(`<div class="result ${treatment.className}">${parts.join('')}</div>`);
  setupNapamsPanel(input);
  setupReportPanel(input, result);
}

function hazardBanner(hazard) {
  const batches = Array.isArray(hazard.batches) && hazard.batches.length > 0
    ? hazard.batches.map(escapeHtml).join(', ')
    : 'see alert for details';
  const type = hazard.alert_type === 'recall' ? 'Recall' : 'Safety alert';
  return `<div class="hazard-alert" role="alert">
    <strong>NAFDAC ${escapeHtml(type)} No. ${escapeHtml(hazard.alert_number)}</strong>
    <span>${escapeHtml(hazard.hazard)}</span>
    <span>Batches: ${batches} · Issued ${escapeHtml(hazard.alert_date)} · <a href="${escapeHtml(hazard.source_url)}" target="_blank" rel="noopener">Official alert</a></span>
  </div>`;
}

function communityBanner(flag) {
  const locations = Array.isArray(flag.recent_locations) && flag.recent_locations.length > 0
    ? flag.recent_locations.map(escapeHtml).join(', ')
    : 'multiple areas';
  return `<div class="community-flag" role="alert">
    <strong>Community warning: ${flag.report_count} reports in the last 30 days</strong>
    <span>Recent areas: ${locations}. These are user reports, not a regulatory finding.</span>
  </div>`;
}

function napamsPanel(input) {
  return `<section class="napams-panel" aria-labelledby="napams-title">
    <div class="napams-panel-head">
      <div>
        <h3 id="napams-title">Check the official NAPAMS record</h3>
        <p>Open NAFDAC’s verifier, complete the CAPTCHA, then save the confirmed result here for faster local checks.</p>
      </div>
      <button id="btn-napams" class="btn btn-secondary" type="button">Open official NAPAMS</button>
    </div>
    <p id="napams-copy-status" class="napams-copy-status" role="status"></p>
    <form id="napams-cache-form" class="napams-form">
      <div class="napams-form-heading">
        <strong>After checking NAPAMS</strong>
        <span>Only save what the official page confirms.</span>
      </div>
      <div class="napams-fields">
        <label>NAFDAC number<input id="cache-nafdac" type="text" value="${escapeHtml(input.nafdac)}" readonly></label>
        <label>Product name<input id="cache-name" type="text" value="${escapeHtml(input.productName)}" maxlength="200" required></label>
        <label>Manufacturer <span>(optional)</span><input id="cache-manufacturer" type="text" value="${escapeHtml(input.manufacturer || '')}" maxlength="200"></label>
        <label>NAPAMS status<select id="cache-status"><option value="Active">Active</option><option value="Inactive">Inactive</option></select></label>
      </div>
      <button class="btn btn-primary" type="submit">Save result to local cache</button>
      <p id="napams-cache-status" class="napams-cache-status" role="status"></p>
    </form>
  </section>`;
}

async function setupNapamsPanel(input) {
  const handoff = document.getElementById('btn-napams');
  const copyStatus = document.getElementById('napams-copy-status');
  handoff?.addEventListener('click', async () => {
    window.open('https://registration.nafdac.gov.ng/', '_blank', 'noopener,noreferrer');
    try {
      await navigator.clipboard.writeText(input.nafdac);
      copyStatus.textContent = 'Official NAPAMS opened and the NAFDAC number was copied.';
    } catch {
      copyStatus.textContent = 'Official NAPAMS opened. Copy the NAFDAC number manually if it was not copied.';
    }
  });

  const form = document.getElementById('napams-cache-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    const status = document.getElementById('napams-cache-status');
    const name = document.getElementById('cache-name').value.trim();
    const manufacturer = document.getElementById('cache-manufacturer').value.trim();
    const napamsStatus = document.getElementById('cache-status').value;
    button.disabled = true;
    status.textContent = 'Saving this result locally…';

    try {
      const response = await fetch('/api/napams/cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nafdac: input.nafdac,
          product_name: name,
          manufacturer,
          status: napamsStatus,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'cache_failed');
      els.nafdac.value = input.nafdac;
      els.name.value = name;
      els.mfr.value = manufacturer;
      status.textContent = 'Saved locally. Checking the product again…';
      await submitVerify();
    } catch (error) {
      status.textContent = `Could not save this result: ${error.message}`;
      button.disabled = false;
    }
  });
}

function reportPanel(input) {
  const photoAvailable = Boolean(els.preview.src);
  return `<section class="report-panel" aria-labelledby="report-title">
    <h3 id="report-title">Does this pack look wrong?</h3>
    <p>Two quick steps and your warning can protect the next shopper. After 3 reports about the same product in 30 days, everyone who checks it sees a warning.</p>
    <ol class="wizard-steps" aria-label="Report progress">
      <li data-wstep="1" class="current" aria-current="step">1 · Issue</li>
      <li data-wstep="2">2 · Details</li>
      <li data-wstep="3">3 · Send</li>
    </ol>
    <form id="report-form" class="report-form" novalidate>
      <div class="wizard-page" data-page="1">
        <p class="wizard-q">What looked wrong with the pack?</p>
        <div class="issue-chips">
          <button type="button" class="chip" data-issue="The seal looked broken or tampered">Broken seal</button>
          <button type="button" class="chip" data-issue="The print looked blurry or wrong">Blurry print</button>
          <button type="button" class="chip" data-issue="It tasted or smelled strange">Strange taste or smell</button>
          <button type="button" class="chip" data-issue="The expiry date looked changed">Changed expiry date</button>
          <button type="button" class="chip" data-issue="">Something else</button>
        </div>
        <button type="button" id="report-no" class="btn btn-ghost">Pack looked fine — no report</button>
      </div>
      <div class="wizard-page hidden" data-page="2">
        <div class="report-fields">
          <label>Where did you see it?<input id="report-area" type="text" maxlength="120" required placeholder="e.g. Ikeja, Lagos"></label>
          <label>Tell us briefly<textarea id="report-note" maxlength="500" required placeholder="e.g. Seal was already cut open"></textarea></label>
        </div>
        <div class="wizard-nav">
          <button type="button" id="report-back-2" class="btn btn-ghost">Back</button>
          <button type="button" id="report-next-2" class="btn btn-secondary">Continue</button>
        </div>
      </div>
      <div class="wizard-page hidden" data-page="3">
        <p class="wizard-q">Anything to attach? Both optional.</p>
        <label class="report-check"><input id="report-photo" type="checkbox" ${photoAvailable ? '' : 'disabled'}> Attach the current product photo</label>
        <button id="report-location" class="btn btn-ghost" type="button">Use my location</button>
        <p id="report-summary" class="wizard-summary"></p>
        <div class="wizard-nav">
          <button type="button" id="report-back-3" class="btn btn-ghost">Back</button>
          <button class="btn btn-primary" type="submit">Submit report</button>
        </div>
      </div>
      <p id="report-status" class="report-status" role="status"></p>
    </form>
  </section>`;
}

function wizardGoto(step) {
  document.querySelectorAll('#report-form .wizard-page').forEach((page) => {
    page.classList.toggle('hidden', page.dataset.page !== String(step));
  });
  document.querySelectorAll('#report-form .wizard-steps li').forEach((item) => {
    const active = item.dataset.wstep === String(step);
    item.classList.toggle('current', active);
    if (active) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
}

async function setupReportPanel(input, result) {
  const form = document.getElementById('report-form');
  if (!form) return;
  const status = document.getElementById('report-status');
  const areaEl = document.getElementById('report-area');
  const noteEl = document.getElementById('report-note');
  let coords = null;

  form.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (chip.dataset.issue) noteEl.value = `${chip.dataset.issue}: `;
      wizardGoto(2);
      areaEl.focus();
    });
  });

  document.getElementById('report-no')?.addEventListener('click', () => {
    form.innerHTML = '<p class="wizard-done">Thanks — no report needed. If anything changes, you can report from a new check.</p>';
  });

  document.getElementById('report-back-2')?.addEventListener('click', () => wizardGoto(1));
  document.getElementById('report-back-3')?.addEventListener('click', () => wizardGoto(2));
  document.getElementById('report-next-2')?.addEventListener('click', () => {
    if (!areaEl.value.trim()) {
      status.textContent = 'Tell us where you saw it — an area or market name is enough.';
      areaEl.focus();
      return;
    }
    if (!noteEl.value.trim()) {
      status.textContent = 'Add one line about what looked wrong.';
      noteEl.focus();
      return;
    }
    status.textContent = '';
    document.getElementById('report-summary').textContent =
      `${input.nafdac} · ${areaEl.value.trim()}`;
    wizardGoto(3);
  });

  document.getElementById('report-location')?.addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      status.textContent = 'Location is not available in this browser.';
      return;
    }
    status.textContent = 'Reading your approximate location…';
    navigator.geolocation.getCurrentPosition(
      (position) => {
        coords = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        status.textContent = 'Location attached. You can still edit the area name.';
      },
      () => {
        status.textContent = 'Location was unavailable. You can still submit the area name.';
      },
      { timeout: 8000 },
    );
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    const area = document.getElementById('report-area').value.trim();
    const note = document.getElementById('report-note').value.trim();
    const attachPhoto = document.getElementById('report-photo')?.checked && Boolean(els.preview.src);
    button.disabled = true;
    status.textContent = 'Submitting your report…';

    try {
      const record = result.matched || result.closest_match || null;
      const response = await fetch('/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nafdac_number: input.nafdac,
          country: input.country,
          location_area: area,
          note,
          photo: attachPhoto ? els.preview.src : undefined,
          latitude: coords?.latitude ?? undefined,
          longitude: coords?.longitude ?? undefined,
          session_id: sessionId(),
          scan_result: {
            status: result.status,
            score: typeof result.score === 'number' ? result.score : null,
            country: input.country,
            product_name: input.productName,
            matched: record ? {
              product_name: record.product_name,
              manufacturer: record.manufacturer,
              country: record.country,
              source: record.source,
            } : null,
          },
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error === 'report_rate_limited'
          ? 'Too many reports from this device. Try again later.'
          : body.error || 'report_failed');
      }
      status.textContent = `Report saved. Checking this product again…`;
      await submitVerify();
    } catch (error) {
      status.textContent = `Could not submit this report: ${error.message}`;
      button.disabled = false;
    }
  });
}

function rowsFor(record) {
  const rows = [
    ['Product name', record.product_name],
    ['Applicant', record.applicant],
    ['Manufacturer', record.manufacturer],
    ['Approval date', record.approval_date],
    ['Expiry date', record.expiry_date],
    ['Category', record.category],
    ['Form', record.form],
    ['Strength', record.strength],
    ['Country', record.country === 'KE' ? 'Kenya (PPB)' : 'Nigeria (NAFDAC)'],
    ['Source', record.source === 'napams_manual' ? 'NAPAMS manual cache' : record.country === 'KE' ? 'Kenya PPB snapshot' : 'Greenbook snapshot'],
  ];
  return rows
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value]) => `<li><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(value)}</span></li>`)
    .join('');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  document.getElementById('install-cta')?.classList.remove('hidden');
});

document.getElementById('btn-install')?.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  installPrompt = null;
  document.getElementById('install-cta')?.classList.add('hidden');
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  document.getElementById('install-cta')?.classList.add('hidden');
});

function syncOfflineNote() {
  document.getElementById('offline-note')?.classList.toggle('hidden', navigator.onLine);
}
window.addEventListener('online', syncOfflineNote);
window.addEventListener('offline', syncOfflineNote);
syncOfflineNote();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}
