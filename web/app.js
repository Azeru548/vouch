const $ = (selector) => document.querySelector(selector);

const els = {
  cameraBtn: $('#btn-camera'),
  fileInput: $('#file-input'),
  thumbsWrap: $('#photo-thumbs'),
  thumbs: $('#thumbs'),
  clearAllBtn: $('#btn-clear-photos'),
  ocrStatus: $('#ocr-status'),
  visionBanner: $('#vision-banner'),
  form: $('#verify-form'),
  country: $('#in-country'),
  nafdac: $('#in-nafdac'),
  name: $('#in-name'),
  batch: $('#in-batch'),
  batchField: $('#batch-field'),
  mfr: $('#in-mfr'),
  confirmHint: $('#confirm-hint'),
  result: $('#result'),
  verifyButton: $('#verify-button'),
  verifyLabel: $('#verify-label'),
};

// Registration-number rules come from /number-normalize.js, which the server
// derives from the same module it uses (window.VouchNumbers). This file used to
// keep its own copy of the pattern, and it was the stale one: it rejected the
// listed/herbal `A7-2363L` series and dash-and-space printings, so a user could
// not even submit a number the server would have verified.
const VouchNumbers = window.VouchNumbers || null;

// Photo sets are bounded so one request cannot exhaust the vision service's
// context window — the server enforces the same limit.
const MAX_PHOTOS = 4;

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
// The photos for the pack currently being checked. The first photo added is
// the pack shot; everything after it is treated as a detail shot (typically
// the registration panel). Both are used by the vision pipeline, and the
// report modal offers each one individually as an attachment.
let photos = [];
// Appearance descriptor for the current photo set, when the vision service
// produced one. Sent to /verify so a pack with no registration number can
// still be compared against the known-fake library.
let packDescriptor = null;
// Increments on every new read so a slow response for an older photo set
// never overwrites the number fields for the current one.
let readAttempt = 0;

fetch('/api/config')
  .then((response) => response.json())
  .then((config) => {
    visionEnabled = config.vision_enabled;
    if (!visionEnabled) {
      els.visionBanner.textContent = 'Photo reading is not configured. You can still attach photos and type the details manually.';
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
    shutter.textContent = photos.length === 0 ? 'Capture pack photo' : 'Add another photo';

    const cancel = document.createElement('button');
    cancel.className = 'btn btn-ghost';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';

    actions.append(shutter, cancel);
    stage.append(video, actions);
    els.thumbsWrap.before(stage);
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
      ingestDataUrl(canvas.toDataURL('image/jpeg', 0.9));
    });
  } catch (error) {
    const reason = error?.name === 'NotAllowedError' ? 'camera permission was denied' : 'the camera could not be opened';
    setOcrStatus(`Could not start the camera because ${reason}. Use “Upload image” instead.`, true);
    els.fileInput.focus();
  }
});

async function readFilesAsDataUrls(fileList) {
  const files = [...fileList].filter((file) => file.type.startsWith('image/'));
  if (files.length === 0) {
    setOcrStatus('Choose image files such as JPG, PNG, or HEIC.', true);
    return;
  }
  for (const file of files) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('read_failed'));
      reader.readAsDataURL(file);
    }).catch(() => null);
    if (!dataUrl) {
      setOcrStatus('One of those images could not be read. The others were kept.', true);
      continue;
    }
    await ingestDataUrl(dataUrl);
  }
}

els.fileInput.addEventListener('change', async () => {
  if (!els.fileInput.files?.length) return;
  await readFilesAsDataUrls(els.fileInput.files);
  els.fileInput.value = '';
});

els.clearAllBtn.addEventListener('click', clearPhotos);

function clearPhotos() {
  if (activeCamera) {
    activeCamera.track.stop();
    activeCamera.stage.remove();
    activeCamera = null;
  }
  els.fileInput.value = '';
  readAttempt += 1;
  photos = [];
  packDescriptor = null;
  renderThumbs();
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

function photoKind(index) {
  if (index === 0) return 'pack';
  if (index === 1) return 'number';
  return 'extra';
}

function photoLabel(kind) {
  if (kind === 'pack') return 'Pack shot';
  if (kind === 'number') return 'Number area';
  return 'Extra photo';
}

async function ingestDataUrl(dataUrl) {
  if (photos.length >= MAX_PHOTOS) {
    setOcrStatus(`Up to ${MAX_PHOTOS} photos per check. Remove one to add another.`, true);
    return;
  }
  let optimized;
  try {
    optimized = await optimizeImage(dataUrl);
  } catch {
    setOcrStatus('That image could not be prepared. Try another file.', true);
    return;
  }
  photos.push({ dataUrl: optimized, kind: photoKind(photos.length), source: 'photo' });
  renderThumbs();
  await runPackRead();
}

function renderThumbs() {
  els.thumbs.innerHTML = photos.map((photo, index) => `
    <figure class="photo-tile" data-photo-index="${index}">
      <img src="${escapeHtml(photo.dataUrl)}" alt="${escapeHtml(photoLabel(photo.kind))}">
      <figcaption>${escapeHtml(photoLabel(photo.kind))}</figcaption>
      <button type="button" class="photo-remove" data-photo-index="${index}" aria-label="Remove ${escapeHtml(photoLabel(photo.kind)).toLowerCase()}">×</button>
    </figure>`).join('');

  const canAddMore = photos.length < MAX_PHOTOS;
  const addTile = canAddMore
    ? `<label class="photo-tile photo-tile-add" for="file-input" title="Add another photo">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        <span>Add photo</span>
      </label>`
    : '';

  els.thumbs.insertAdjacentHTML('beforeend', addTile);
  els.thumbsWrap.classList.toggle('hidden', photos.length === 0);

  els.thumbs.querySelectorAll('.photo-remove').forEach((button) => {
    button.addEventListener('click', () => removePhoto(Number(button.dataset.photoIndex)));
  });
}

function removePhoto(index) {
  photos.splice(index, 1);
  photos = photos.map((photo, position) => ({ ...photo, kind: photoKind(position) }));
  readAttempt += 1;
  if (photos.length === 0) {
    clearPhotos();
    return;
  }
  renderThumbs();
  runPackRead();
}

// One read over the whole photo set: the number is extracted across all of
// the shots (pack overview plus registration-panel close-ups), and the
// appearance description runs alongside it. A description is a bonus, never a
// requirement: if it fails, the registry check still goes ahead.
async function runPackRead() {
  const attempt = ++readAttempt;
  const imageList = photos.map((photo) => photo.dataUrl);
  if (imageList.length === 0) return;

  if (!visionEnabled) {
    packDescriptor = null;
    setOcrStatus(`${imageList.length > 1 ? 'Photos attached' : 'Photo attached'}. Type the NAFDAC number below to check it.`, true);
    els.nafdac.focus();
    return;
  }

  setOcrStatus(`<span class="spinner spinner-dark"></span>Reading your ${imageList.length > 1 ? 'photos' : 'photo'}…`);
  els.thumbsWrap.classList.add('is-reading');
  describePack(imageList, attempt);

  try {
    const response = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: imageList, country: els.country.value }),
    });
    const result = await response.json();
    if (attempt !== readAttempt) return;
    els.thumbsWrap.classList.remove('is-reading');

    if (!response.ok) {
      // A busy photo reader is not a failed check: say so, and keep the photos
      // on screen so the user can just tap to read again.
      if (result.error === 'vision_rate_limited') {
        setOcrStatus('Photo reading is busy right now. Tap the photos to read them again in a few seconds, or type the numbers below.', true);
      } else {
        setOcrStatus(
          result.error === 'vision_not_configured'
            ? 'Photo reading is not configured. Type the numbers below.'
            : 'Photo reading could not finish. Type the numbers below.',
          true,
        );
      }
      els.nafdac.focus();
      return;
    }

    // Kenya packs: the batch code is often the only readable number on the
    // blister, so it is filled whenever the photos show one.
    if (result.batch_number && !els.batch.value.trim()) {
      els.batch.value = result.batch_number;
    }

    if (result.usable) {
      els.nafdac.value = result.nafdac_number;
      const batchNote = result.batch_number ? ' Batch number filled in below.' : '';
      setOcrStatus(`Read ${els.country.value === 'KE' ? 'registration' : 'NAFDAC'} number “${result.nafdac_number}”${imageList.length > 1 ? ' from your photos' : ''}.${batchNote} Check it, then enter the product name.`);
      els.nafdac.focus();
      els.nafdac.select();
      return;
    }

    els.nafdac.value = result.nafdac_number || '';
    if (result.nafdac_number && !result.format_valid) {
      setOcrStatus(`Read “${result.nafdac_number}”, but its format is not valid. Correct it below.`, true);
    } else if (result.batch_number) {
      setOcrStatus(`No registration number found, but batch “${result.batch_number}” was filled in. Enter the numbers printed on the pack below.`, true);
    } else {
      setOcrStatus('No clear registration number was found in your photos. Enter it below.', true);
    }
    els.confirmHint.textContent = 'Correct the number if needed, then enter the exact product name.';
    els.nafdac.focus();
  } catch {
    if (attempt !== readAttempt) return;
    els.thumbsWrap.classList.remove('is-reading');
    setOcrStatus('Photo reading could not be reached. Type the NAFDAC number below.', true);
    els.nafdac.focus();
  }
}

async function describePack(imageList, attempt) {
  packDescriptor = null;
  try {
    const response = await fetch('/api/describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: imageList }),
    });
    if (!response.ok || attempt !== readAttempt) return;
    const result = await response.json();
    if (attempt !== readAttempt) return;
    packDescriptor = typeof result.descriptor === 'string' && result.descriptor ? result.descriptor : null;
  } catch {}
}

function setOcrStatus(html, warn = false) {
  els.ocrStatus.innerHTML = html;
  els.ocrStatus.classList.remove('hidden');
  els.ocrStatus.classList.toggle('warn', warn);
}

// The batch field is Kenya-only and compulsory there: PPB recalls are
// batch-specific and the batch is usually the only readable number on a
// Kenyan pack. NAFDAC alerts almost never cite batches, so Nigeria skips the
// field entirely until that changes. Re-checked whenever the country flips.
function setCountryState() {
  const ke = els.country.value === 'KE';
  els.batchField.classList.toggle('hidden', !ke);
  els.batch.required = ke;
  if (!ke) els.batch.value = '';
}
els.country.addEventListener('change', setCountryState);
setCountryState();

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitVerify();
});

async function submitVerify() {
  const nafdac = els.nafdac.value.trim();
  const productName = els.name.value.trim();
  const batch = els.batch.value.trim();
  const manufacturer = els.mfr.value.trim();
  const country = els.country.value;

  if (!els.form.reportValidity()) return;
  // The registration number is optional. With it we check the registry; without
  // it we only have the name and photos to compare against known fakes.
  // Kenya: the batch is required. It is the one verifiable signal a shopper
  // can read on a Kenyan pack, and 81% of our PPB alerts are batch-specific.
  if (country === 'KE' && !batch) {
    showLocalError('Enter the batch (LOT) number printed on the pack — PPB recalls are batch-specific, so it decides whether your pack is on one.');
    els.batch.focus();
    return;
  }
  if (nafdac) {
    // Validated with the shared module so the browser cannot reject a number the
    // server would accept. If the module somehow failed to load, fall back to
    // letting the request through and letting the server be the judge, rather
    // than blocking the user on a client-side guess.
    const validNumber = VouchNumbers
      ? VouchNumbers.isPlausibleRegistrationNumber(nafdac, country)
      : true;
    if (!validNumber) {
      showLocalError(country === 'KE'
        ? 'Enter the Kenya PPB registration number exactly as printed on the pack, or leave the field blank.'
        : 'Enter the NAFDAC number in the format shown on the pack, such as A11-0009, A7-2363L, or leave the field blank.');
      els.nafdac.focus();
      return;
    }
  }
  if (!productName) {
    showLocalError('Enter the product name exactly as printed on the pack.');
    els.name.focus();
    return;
  }

  setResult(nafdac
    ? '<div class="result r-loading"><div class="result-head"><span class="spinner"></span><h2>Checking the registry…</h2></div><p class="result-message">Comparing the product details with the local NAFDAC snapshot.</p></div>'
    : '<div class="result r-loading"><div class="result-head"><span class="spinner"></span><h2>Checking known fakes…</h2></div><p class="result-message">No registration number was entered, so this compares the name and photos with our library of flagged products.</p></div>');
  els.verifyButton.disabled = true;
  els.verifyLabel.textContent = nafdac ? 'Checking registration…' : 'Checking known fakes…';

  const query = new URLSearchParams({ product_name: productName, country });
  if (nafdac) query.set('nafdac', nafdac);
  if (manufacturer) query.set('manufacturer', manufacturer);
  if (batch) query.set('batch', batch);
  if (packDescriptor) query.set('appearance', packDescriptor);

  try {
    const response = await fetch(`/verify?${query}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'verification_failed');
    paint(result, { nafdac, productName, batch, manufacturer, country });
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
    const batchNote = batchNoteFor(result.hazard, input.batch);
    if (batchNote) parts.push(`<p class="result-warn-note batch-note">${batchNote}</p>`);
    parts.push(comparePanel(result.hazard));
  }
  if (result.community_flag?.flagged) {
    parts.push(communityBanner(result.community_flag));
  }
  parts.push(
    `<div class="result-head"><span class="result-badge">${treatment.badge}</span><h2>${escapeHtml(treatment.title)}</h2></div>`,
  );

  if (result.status === 'not_found') {
    parts.push(
      input.nafdac
        ? '<p class="result-message">This number is not in our copy of the registry. Double-check it against the pack — if it matches, the product may be unregistered, or our copy may be out of date.</p>'
        : '<p class="result-message">No registration number was entered, so only the product name and photos were compared with known fakes. Add the number from the pack for a full registration check.</p>',
      `<ul class="result-meta">
        ${input.nafdac ? `<li><span class="k">NAFDAC number</span><span class="v">${escapeHtml(input.nafdac)}</span></li>` : ''}
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

  if (Array.isArray(result.suspects) && result.suspects.length > 0) {
    parts.push(suspectsPanel(result.suspects));
  }

  if (Array.isArray(result.enforcement_notes) && result.enforcement_notes.length > 0) {
    parts.push(enforcementPanel(result.enforcement_notes));
  }

  // The NAPAMS handoff is keyed by a registration number, so it is only
  // offered when the user entered one. Reporting is not: it is asked after
  // every check, including the ones with no number.
  if (input.nafdac && input.country === 'NG' && (result.status === 'mismatch' || result.status === 'not_found')) {
    parts.push(napamsPanel(input));
  }

  parts.push(resultLegend());
  parts.push('<p class="result-footnote">This result reflects the local registry snapshot and does not assess product quality or authenticity beyond the available registration data.</p>');
  setResult(`<div class="result ${treatment.className}">${parts.join('')}</div>`);
  setupNapamsPanel(input);

  if (skipNextReportPrompt) {
    skipNextReportPrompt = false;
  } else {
    openReportModal(input, result);
  }
}

// 'NAFDAC' or 'PPB' — the short badge form for tight UI spots.
function authorityShort(sourceCountry) {
  return sourceCountry === 'KE' ? 'PPB' : 'NAFDAC';
}

function authorityFull(sourceCountry) {
  return sourceCountry === 'KE' ? 'Pharmacy and Poisons Board (PPB), Kenya' : 'NAFDAC, Nigeria';
}

// One honest sentence under the hazard banner saying how far the batch check
// went — or nothing when no batch was entered and none is needed to read the
// alert.
function batchNoteFor(hazard, batch) {
  const listed = Array.isArray(hazard.batches) && hazard.batches.length > 0;
  const batchText = listed ? hazard.batches.map(escapeHtml).join(', ') : '';
  if (hazard.batch_tier === 'batch_matched') {
    return `Your batch <strong>${escapeHtml(batch || '')}</strong> is on this alert's batch list (${batchText}). Treat this pack as part of the recall.`;
  }
  if (hazard.batch_tier === 'batch_not_listed') {
    return `This alert is batch-specific (batches ${batchText}) and batch <strong>${escapeHtml(batch || '')}</strong> is not on the list — but a clean batch does not prove a pack is genuine. Compare the photos and check with a pharmacist.`;
  }
  return '';
}

// Every verdict and batch tier, in one plain sentence each. A first-time
// user should never have to guess what a badge is promising — or refusing —
// to promise.
function resultLegend() {
  return `<section class="result-legend" aria-label="How to read this result">
    <h4>How to read this result</h4>
    <ul>
      <li><strong>Registry match</strong> — the number is on the regulator's list and active.</li>
      <li><strong>Approval not active</strong> — it is on the list, but expired or suspended.</li>
      <li><strong>Details mismatch</strong> — a similar record exists, but it does not confirm your pack.</li>
      <li><strong>Not found</strong> — no record for what you typed; unregistered, mistyped, or our copy is behind. On its own it is not proof of fake.</li>
      <li><strong>Your batch is listed</strong> — your pack is on a recall. Do not use it.</li>
      <li><strong>Your batch is not listed</strong> — the recall is real, but your batch is not on it. Still not proof the pack is genuine.</li>
    </ul>
  </section>`;
}

function hazardBanner(hazard) {
  const batches = Array.isArray(hazard.batches) && hazard.batches.length > 0
    ? hazard.batches.map(escapeHtml).join(', ')
    : 'see alert for details';
  const type = hazard.alert_type === 'recall' ? 'Recall' : 'Safety alert';
  const short = authorityShort(hazard.source_country);
  const tierTag = hazard.batch_tier === 'batch_matched'
    ? ' · <strong>your batch is listed</strong>'
    : hazard.batch_tier === 'batch_not_listed'
      ? ' · your batch is not listed'
      : '';
  return `<div class="hazard-alert" role="alert">
    <strong>${escapeHtml(short)} ${escapeHtml(type)}${hazard.alert_number ? ` No. ${escapeHtml(hazard.alert_number)}` : ''}</strong>
    <span>${escapeHtml(hazard.hazard)}</span>
    <span>Source: ${escapeHtml(authorityFull(hazard.source_country))} · Batches: ${batches}${tierTag} · Issued ${escapeHtml(hazard.alert_date)} · <a href="${escapeHtml(hazard.source_url)}" target="_blank" rel="noopener">Official alert</a></span>
  </div>`;
}

function comparePanel(hazard) {
  const userPhoto = photos[0]?.dataUrl || '';
  const userCaption = photos.length > 1 ? `Your photo (1 of ${photos.length})` : 'Your photo';
  const refs = Array.isArray(hazard.photos) ? hazard.photos.slice(0, 2) : [];
  if (!userPhoto || refs.length === 0) return '';
  const authority = hazard.authority || authorityShort(hazard.source_country);
  return `<section class="compare-panel" aria-label="Compare your pack with the flagged pack">
    <h3>Compare these two packs</h3>
    <p>Left: your photo. Right: ${escapeHtml(authority)}'s photo of the flagged product. Check the seal, print, colours, and spelling — fakes often differ in small details.</p>
    <div class="compare-grid">
      <figure><img src="${escapeHtml(userPhoto)}" alt="Your product photo"><figcaption>${escapeHtml(userCaption)}</figcaption></figure>
      <figure>${refs.map((src) => `<img src="${escapeHtml(src)}" alt="Official photo of the flagged product" loading="lazy">`).join('')}<figcaption>Official flagged pack</figcaption></figure>
    </div>
  </section>`;
}

const CATEGORY_LABELS = {
  drug: 'Medicine',
  food: 'Food or drink',
  cosmetic: 'Cosmetic',
  device: 'Medical device',
  chemical: 'Chemical',
  other: 'Regulated product',
};

// Leads from the known-fake library. Deliberately framed as leads, not a
// finding: the match is fuzzy by nature and must never read as a verdict.
function suspectsPanel(suspects) {
  const cards = suspects.map((suspect) => {
    const photo = Array.isArray(suspect.photos) ? suspect.photos[0] : null;
    const category = CATEGORY_LABELS[suspect.category] || CATEGORY_LABELS.other;
    const short = authorityShort(suspect.source_country);
    const batches = Array.isArray(suspect.batches) && suspect.batches.length > 0
      ? `Batches ${suspect.batches.map(escapeHtml).join(', ')}`
      : 'No batch listed';
    const why = suspect.matched_on === 'appearance'
      ? 'Your photo looks like this flagged pack'
      : 'The name you entered is close to this flagged product';
    return `<li class="suspect">
      ${photo ? `<img src="${escapeHtml(photo)}" alt="Official photo of the flagged product" loading="lazy">` : ''}
      <div class="suspect-body">
        <span class="suspect-cat">${escapeHtml(category)}</span>
        <span class="suspect-cat suspect-src">${escapeHtml(short)}</span>
        <strong>${escapeHtml(suspect.product_name)}</strong>
        <p>${escapeHtml(suspect.hazard)}</p>
        <p class="suspect-why">${why} · ${Math.max(0, Math.min(100, Math.round(suspect.score)))}% similarity</p>
        <p class="suspect-meta">${batches} · <a href="${escapeHtml(suspect.source_url)}" target="_blank" rel="noopener">${escapeHtml(short)} alert ${escapeHtml(suspect.alert_number)}</a></p>
      </div>
    </li>`;
  }).join('');

  return `<section class="suspect-panel" aria-labelledby="suspect-title">
    <h3 id="suspect-title">Possible match in our flagged-products library</h3>
    <p>These are leads from official regulator alerts — NAFDAC (Nigeria) and the Pharmacy and Poisons Board (Kenya) — matched on the name you typed and any photos you attached. Each lead says which regulator flagged it. They are not a finding — compare the pack by hand before you decide.</p>
    <ul class="suspect-list">${cards}</ul>
    <p class="suspect-more">The full register of flagged products, with every reference photo, lives on the <a href="/alerts.html">Flagged products page</a>.</p>
  </section>`;
}

// Enforcement actions: raids, destruction exercises and lab cases that NAFDAC
// has made public. Deliberately a different panel from the alert banner and the
// suspect leads — an enforcement action names no batch and carries no alert
// number, so it can never confirm or refute the pack in someone's hand. The
// wording says so on the panel itself, so the note cannot be misread as a verdict.
function enforcementPanel(notes) {
  const cards = notes.map((note) => {
    const when = formatActionDate(note.action_date);
    const where = note.location ? ` · ${escapeHtml(note.location)}` : '';
    return `<li class="enforcement-item">
      <div class="enforcement-body">
        <span class="enforcement-cat">${escapeHtml(note.authority)} enforcement action</span>
        <strong>${escapeHtml(note.summary)}</strong>
        <p class="enforcement-meta">${escapeHtml(when)}${where} · matched: ${escapeHtml(note.matched_brands.join(', '))}</p>
        <p class="enforcement-note">${escapeHtml(note.evidence_note || '')}</p>
        <p class="enforcement-source">Source: <a href="${escapeHtml(note.source_url)}" target="_blank" rel="noopener">${escapeHtml(note.source_publisher)}</a></p>
      </div>
    </li>`;
  }).join('');

  return `<section class="enforcement-panel" aria-labelledby="enforcement-title">
    <h3 id="enforcement-title">Enforcement action on record for this brand</h3>
    <p>NAFDAC has publicly acted on this brand. This is a record of that action, with its date and source — it is <strong>not</strong> a finding about the pack you are checking. Enforcement actions name no batch and carry no alert number, so they cannot confirm or refute any single product.</p>
    <ul class="enforcement-list">${cards}</ul>
  </section>`;
}

function formatActionDate(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return escapeHtml(value);
  return parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
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
      skipNextReportPrompt = true;
      await submitVerify();
    } catch (error) {
      status.textContent = `Could not save this result: ${error.message}`;
      button.disabled = false;
    }
  });
}

// ---------- alerts-cue announcement ----------
//
// The flagged-products register is easy to miss as a footer link, so the main
// page announces it once. Dismissal persists for 30 days, then it asks again.

const ALERTS_CUE_KEY = 'vouch-alerts-cue-dismissed-at';
const ALERTS_CUE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

function setupAlertsCue() {
  const cue = document.getElementById('alerts-cue');
  if (!cue) return;
  let dismissedAt = 0;
  try {
    dismissedAt = Number(window.localStorage.getItem(ALERTS_CUE_KEY) || 0);
  } catch {}
  if (Number.isFinite(dismissedAt) && Date.now() - dismissedAt < ALERTS_CUE_COOLDOWN_MS) return;
  cue.classList.remove('hidden');
  document.getElementById('alerts-cue-dismiss')?.addEventListener('click', () => {
    cue.classList.add('hidden');
    try {
      window.localStorage.setItem(ALERTS_CUE_KEY, String(Date.now()));
    } catch {}
  });
}
setupAlertsCue();

// ---------- post-check report modal ----------
//
// The modal opens after every check and leads with the outcome of the check
// itself — the same verdict badge the result region shows, blue when the
// registry matched — so the shopper always knows what they are being asked to
// report on. Each photo taken for the check can be attached to the report
// individually, with the pack shot pre-selected.

const REPORT_ISSUES = [
  { label: 'Seal broken or resealed', note: 'The seal looked broken or tampered with' },
  { label: 'Blurry or wrong print', note: 'The print looked blurry or wrong' },
  { label: 'Different colour or design', note: 'The colour or design looked different from the pack I usually buy' },
  { label: 'Strange taste or smell', note: 'It tasted or smelled strange' },
  { label: 'Expiry date looks changed', note: 'The expiry date looked changed' },
  { label: 'Something else', note: '' },
];

const REPORT_LEDES = {
  verified: 'The registry matched this pack. A damaged or resealed pack can still be a problem, so tell us if something looked off.',
  verified_inactive: 'This approval is not active right now. Did the pack look different or damaged where you bought it?',
  mismatch: 'These details did not match the registry. Does the pack look different or damaged?',
  not_found: 'This pack could not be confirmed. Does it look different or damaged?',
};

// Same visual language as the result region: reusing the r-* classes means
// the badge colours stay defined in exactly one place in the stylesheet.
const VERDICT_STRIP = {
  verified: { className: 'r-verified', badge: 'Registry match', text: 'Registered and active' },
  verified_inactive: { className: 'r-inactive', badge: 'Approval not active', text: 'Registered, but the approval is not active' },
  mismatch: { className: 'r-mismatch', badge: 'Details mismatch', text: 'Could not be confirmed' },
  not_found: { className: 'r-notfound', badge: 'Not found', text: 'No matching registration found' },
};

let reportModalEl = null;
// Set when a check is re-run on purpose (after a report or a NAPAMS cache save)
// so the modal does not immediately ask the same question again.
let skipNextReportPrompt = false;
let lastFocusedBeforeModal = null;

function closeReportModal() {
  if (!reportModalEl) return;
  reportModalEl.remove();
  reportModalEl = null;
  document.documentElement.classList.remove('modal-open');
  const restore = lastFocusedBeforeModal;
  lastFocusedBeforeModal = null;
  if (restore && document.contains(restore)) restore.focus({ preventScroll: true });
}

document.addEventListener('keydown', (event) => {
  if (!reportModalEl) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeReportModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...reportModalEl.querySelectorAll('button, input, textarea, a[href]')]
    .filter((element) => !element.disabled);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

// The reference pack: whatever official imagery this check turned up, or the
// alert's written descriptor when NAFDAC published no photo. Never a stand-in.
function reportReference(result) {
  const hazard = result.hazard;
  const suspects = Array.isArray(result.suspects) ? result.suspects : [];
  const referencePhotos = [];
  for (const src of [...(hazard?.photos || []), ...suspects.flatMap((suspect) => suspect.photos || [])]) {
    if (typeof src === 'string' && src && !referencePhotos.includes(src)) referencePhotos.push(src);
  }
  const alertNumber = hazard?.alert_number || suspects[0]?.alert_number || null;
  const sourceUrl = hazard?.source_url || suspects.find((suspect) => suspect.source_url)?.source_url || null;
  const link = sourceUrl
    ? `<a class="modal-reference-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">Read the official alert${alertNumber ? ` ${escapeHtml(alertNumber)}` : ''}</a>`
    : '';

  if (referencePhotos.length > 0) {
    const refs = referencePhotos.slice(0, 2);
    const userPhoto = photos[0]?.dataUrl || '';
    const userCaption = photos.length > 1 ? `Your photo (1 of ${photos.length})` : 'Your photo';
    return `<div class="modal-reference">
      <p class="modal-reference-label">NAFDAC's photo of the flagged pack${alertNumber ? ` · alert ${escapeHtml(alertNumber)}` : ''}</p>
      <div class="compare-grid">
        ${userPhoto ? `<figure><img src="${escapeHtml(userPhoto)}" alt="Your product photo"><figcaption>${escapeHtml(userCaption)}</figcaption></figure>` : ''}
        <figure>
          ${refs.map((src) => `<img src="${escapeHtml(src)}" alt="Official NAFDAC photo of the flagged product" loading="lazy">`).join('')}
          <figcaption>Flagged pack</figcaption>
        </figure>
      </div>
      ${link}
    </div>`;
  }

  const appearance = suspects.find((suspect) => suspect.appearance)?.appearance;
  if (appearance) {
    return `<div class="modal-reference modal-reference-text">
      <p class="modal-reference-label">No photo exists for this alert${alertNumber ? ` (${escapeHtml(alertNumber)})` : ''} — here is what to look for</p>
      <p>${escapeHtml(appearance)}</p>
      ${link}
    </div>`;
  }
  return '';
}

function reportVerdictStrip(result) {
  const strip = VERDICT_STRIP[result.status] || VERDICT_STRIP.not_found;
  const notes = [];
  if (result.hazard) {
    const type = result.hazard.alert_type === 'recall' ? 'recall' : 'safety alert';
    notes.push(`${result.hazard.authority || authorityShort(result.hazard.source_country)} has an active ${type} on this product${result.hazard.alert_number ? ` (${result.hazard.alert_number})` : ''}`);
  }
  if (result.community_flag?.flagged) {
    notes.push(`${result.community_flag.report_count} community reports in the last 30 days`);
  }
  const noteHtml = notes.length > 0
    ? `<p class="modal-verdict-note">${escapeHtml(notes.join(' · '))}</p>`
    : '';
  return `<div class="modal-verdict ${strip.className}">
    <span class="result-badge">${strip.badge}</span>
    <span class="modal-verdict-text">${escapeHtml(strip.text)}</span>
  </div>${noteHtml}`;
}

// Attach choices: one tile per photo taken for this check, pack shot
// pre-selected. The first checked photo travels in the report's photo field.
function reportAttachChoices() {
  if (photos.length === 0) {
    return '<p class="report-attach-none">No photo was taken for this check.</p>';
  }
  return `<div class="report-attach-tiles" id="report-attach-tiles">
    ${photos.map((photo, index) => `
      <label class="report-attach-tile">
        <input type="checkbox" data-photo-index="${index}" ${photo.kind === 'pack' ? 'checked' : ''}>
        <img src="${escapeHtml(photo.dataUrl)}" alt="Attach photo ${index + 1}">
        <span>${escapeHtml(photoLabel(photo.kind))}</span>
      </label>`).join('')}
  </div>`;
}

function openReportModal(input, result) {
  closeReportModal();
  const modal = document.createElement('div');
  modal.className = 'report-modal';
  modal.id = 'report-modal';
  modal.innerHTML = `
    <section class="report-modal-card" role="dialog" aria-modal="true" aria-labelledby="report-modal-title" tabindex="-1">
      <button type="button" class="modal-close" id="report-close" aria-label="Close without reporting">\u00d7</button>
      <p class="modal-kicker">Your check result</p>
      ${reportVerdictStrip(result)}
      <h2 id="report-modal-title">Did this pack look different or damaged?</h2>
      <p class="modal-lede">${escapeHtml(REPORT_LEDES[result.status] || REPORT_LEDES.not_found)}</p>
      <p class="modal-pack">${escapeHtml(input.productName)} <span>${input.nafdac ? escapeHtml(input.nafdac) : 'no registration number entered'}</span></p>
      ${reportReference(result)}
      <form id="report-form" class="report-form" novalidate>
        <p class="report-question" id="report-issue-label">What would you tell the next shopper?</p>
        <div class="issue-chips" role="group" aria-labelledby="report-issue-label">
          ${REPORT_ISSUES.map((issue, index) => `<button type="button" class="chip" data-issue-index="${index}" aria-pressed="false">${escapeHtml(issue.label)}</button>`).join('')}
        </div>
        <div class="report-fields">
          <label for="report-area">Where did you see it?<input id="report-area" type="text" maxlength="120" autocomplete="off" placeholder="e.g. Ikeja, Lagos"></label>
          <label for="report-note">What did you notice?<textarea id="report-note" maxlength="500" placeholder="e.g. Seal was already cut open"></textarea></label>
        </div>
        <div class="report-attach">
          <p class="report-attach-label" id="report-attach-label">Attach photos of the pack <span>(optional)</span></p>
          ${reportAttachChoices()}
          <button id="report-location" class="btn btn-ghost" type="button">Use my location</button>
        </div>
        <p id="report-status" class="report-status" role="status"></p>
        <div class="modal-actions">
          <button type="button" id="report-no" class="btn btn-ghost">Pack looked fine</button>
          <button class="btn btn-primary" type="submit">Send report</button>
        </div>
      </form>
    </section>`;

  document.body.append(modal);
  reportModalEl = modal;
  document.documentElement.classList.add('modal-open');
  lastFocusedBeforeModal = document.activeElement;
  modal.addEventListener('mousedown', (event) => {
    if (event.target === modal) closeReportModal();
  });
  modal.querySelector('.report-modal-card').focus({ preventScroll: true });
  setupReportForm(modal, input, result);
}

function setupReportForm(modal, input, result) {
  const form = modal.querySelector('#report-form');
  const status = modal.querySelector('#report-status');
  const areaEl = modal.querySelector('#report-area');
  const noteEl = modal.querySelector('#report-note');
  const sendButton = form.querySelector('button[type=submit]');
  const chips = [...form.querySelectorAll('.chip')];
  let coords = null;

  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const issue = REPORT_ISSUES[Number(chip.dataset.issueIndex)];
      chips.forEach((other) => {
        const active = other === chip;
        other.classList.toggle('selected', active);
        other.setAttribute('aria-pressed', String(active));
      });
      if (issue?.note) noteEl.value = issue.note;
      areaEl.focus();
    });
  });

  modal.querySelector('#report-close').addEventListener('click', closeReportModal);
  modal.querySelector('#report-no').addEventListener('click', closeReportModal);

  modal.querySelector('#report-location').addEventListener('click', () => {
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
    const area = areaEl.value.trim();
    const note = noteEl.value.trim();
    if (!note) {
      status.textContent = 'Pick what looked wrong above, or add a line of your own.';
      noteEl.focus();
      return;
    }
    if (!area) {
      status.textContent = 'Tell us where you saw it — an area or market name is enough.';
      areaEl.focus();
      return;
    }
    const attachedPhotos = [...modal.querySelectorAll('#report-attach-tiles input:checked')]
      .map((box) => photos[Number(box.dataset.photoIndex)]?.dataUrl)
      .filter(Boolean);
    sendButton.disabled = true;
    status.textContent = 'Submitting your report…';

    try {
      const record = result.matched || result.closest_match || null;
      const response = await fetch('/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nafdac_number: input.nafdac || undefined,
          product_name: input.productName,
          country: input.country,
          location_area: area,
          note,
          photo: attachedPhotos[0],
          latitude: coords?.latitude ?? undefined,
          longitude: coords?.longitude ?? undefined,
          session_id: sessionId(),
          scan_result: {
            status: result.status,
            score: typeof result.score === 'number' ? result.score : null,
            country: input.country,
            product_name: input.productName,
            batch: input.batch || null,
            matched: record ? {
              product_name: record.product_name,
              manufacturer: record.manufacturer,
              country: record.country,
              source: record.source,
            } : null,
            suspects: Array.isArray(result.suspects)
              ? result.suspects.map((suspect) => ({
                  alert_number: suspect.alert_number,
                  category: suspect.category,
                  score: suspect.score,
                  matched_on: suspect.matched_on,
                }))
              : [],
          },
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error === 'report_rate_limited'
          ? 'Too many reports from this device. Try again later.'
          : body.error || 'report_failed');
      }
      status.textContent = 'Report saved. Thank you — refreshing the check…';
      skipNextReportPrompt = true;
      await new Promise((resolve) => setTimeout(resolve, 900));
      closeReportModal();
      await submitVerify();
    } catch (error) {
      status.textContent = `Could not submit this report: ${error.message}`;
      sendButton.disabled = false;
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
