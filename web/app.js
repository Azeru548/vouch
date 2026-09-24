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
  nafdac: $('#in-nafdac'),
  name: $('#in-name'),
  mfr: $('#in-mfr'),
  confirmHint: $('#confirm-hint'),
  result: $('#result'),
  verifyButton: $('#verify-button'),
  verifyLabel: $('#verify-label'),
};

const NAFDAC_RE = /^[A-Z0-9]{1,3}-\d{3,6}$/i;
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

  if (!els.form.reportValidity()) return;
  if (!NAFDAC_RE.test(nafdac)) {
    showLocalError('Enter the NAFDAC number in the format shown on the pack, such as A11-0009.');
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

  const query = new URLSearchParams({ nafdac, product_name: productName });
  if (manufacturer) query.set('manufacturer', manufacturer);

  try {
    const response = await fetch(`/verify?${query}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'verification_failed');
    paint(result, { nafdac, productName, manufacturer });
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
      badge: 'Inactive listing',
      title: 'This product is registered but inactive',
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

  const treatment = treatments[result.status];
  if (!treatment) {
    showServiceError(new Error(`Unexpected response status: ${result.status}`));
    return;
  }

  const record = result.matched || result.closest_match;
  const parts = [
    `<div class="result-head"><span class="result-badge">${treatment.badge}</span><h2>${escapeHtml(treatment.title)}</h2></div>`,
  ];

  if (result.status === 'not_found') {
    parts.push(
      '<p class="result-message">This number was not found in the current local registry snapshot.</p>',
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

  if (result.status === 'mismatch' || result.status === 'not_found') {
    parts.push('<p class="report-note">Product reporting is planned for a future release. Keep the packaging and purchase details for your records.</p>');
  }

  parts.push('<p class="result-footnote">This result reflects the local registry snapshot and does not assess product quality or authenticity beyond the available registration data.</p>');
  setResult(`<div class="result ${treatment.className}">${parts.join('')}</div>`);
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
  ];
  return rows
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value]) => `<li><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(value)}</span></li>`)
    .join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}
