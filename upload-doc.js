// upload-doc.js — robust signature pad fix & high-res export
(() => {
  const $ = id => document.getElementById(id);
  const step1 = $('step1'), step2 = $('step2'), step3 = $('step3');
  const customerIdEl = $('customerId'), termOtherEl = $('termOther'), termsBox = $('termsBox');
  const toStep2Btn = $('toStep2');
  const docInput = $('docInput');
  const stage = $('stage'), displayCanvas = $('displayCanvas'), sigBoxEl = $('sigBox'), sigPad = $('sigPad');
  const zoomInBtn = $('zoomIn'), zoomOutBtn = $('zoomOut'), resetViewBtn = $('resetView'), lockAndSignBtn = $('lockAndSign');
  const previewImg = $('previewImg'), backToSignBtn = $('backToSign'), saveBtn = $('saveBtn'), statusEl = $('status');
  const saveMessage = $('saveMessage');
  const EXPORT_SCALE = 3; // increase to produce higher final JPG resolution

  // Terms
  const TERMS = ['PAN','Peri','FI','Núcleo','Coroa','Inicial','Final','PIX','ONF'];
  function renderTerms(){
    termsBox.innerHTML = '';
    TERMS.forEach(t=>{
      const lab = document.createElement('label'); lab.className='chip';
      lab.innerHTML = `<input type="checkbox" value="${t}"/> <span>${t}</span>`;
      termsBox.appendChild(lab);
    });
  }
  renderTerms();

  // state
  let customerId = '';
  let termsState = new Set();
  let imgBitmap = null;     // Image element used for drawing/display
  let fullCanvas = null;    // high-res canvas used for final export
  let fCtx = null;
  let uploadedPdfFilename = null;
  let penThickness = 2; // 1..3

  // display canvas context
  const dCtx = displayCanvas.getContext('2d');

  // transforms
  let stageW=0, stageH=0;
  let scale=1, offsetX=0, offsetY=0, minScale=0.2, maxScale=6;
  let pointers = new Map();
  let lastX=0, lastY=0, isPanning=false;

  // signature rect (display-space)
  const sigRect = { x:0, y:0, w:0, h:0 };

  // final output
  let finalImageData = null;

  // flags & signature state
  let docLocked = false;
  let signingEnabled = false;
  let sigCtx = null;
  let signatureHandlers = null;

  // UI navigation
  function showStep(n){
    step1.classList.toggle('hidden', n!==1);
    step2.classList.toggle('hidden', n!==2);
    step3.classList.toggle('hidden', n!==3);
  }
  showStep(1);

  // Step1 -> Step2
  toStep2Btn.addEventListener('click', () => {
    const cid = (customerIdEl.value||'').trim();
    if(!/^\d{1,8}$/.test(cid)){ alert('Informe o ID do cliente (1 a 8 dígitos)'); return; }
    customerId = cid;
    termsState = new Set(Array.from(document.querySelectorAll('#termsBox input:checked')).map(i=>i.value));
    if(termOtherEl.value.trim()) termsState.add(termOtherEl.value.trim());
    showStep(2);
    setTimeout(resizeStage, 60);
  });

  // Stage sizing & signature box sizing
  function resizeStage(){
    const rect = stage.getBoundingClientRect();
    stageW = Math.max(320, Math.floor(rect.width));
    stageH = Math.max(360, Math.floor(rect.width * 0.64));
    displayCanvas.width = stageW;
    displayCanvas.height = stageH;

    // signature box taller (about half of stage height approx)
    sigRect.w = Math.floor(stageW * 0.9);
    sigRect.h = Math.floor(stageH * 0.39); // increased height
    sigRect.x = Math.floor((stageW - sigRect.w)/2);
    sigRect.y = Math.floor(stageH - sigRect.h - 16);

    sigBoxEl.style.left = sigRect.x + 'px';
    sigBoxEl.style.top = sigRect.y + 'px';
    sigBoxEl.style.width = sigRect.w + 'px';
    sigBoxEl.style.height = sigRect.h + 'px';

    // position sigPad absolutely inside the stage
    // We will (re)parent sigPad to stage to avoid sigBox interference
    try {
      if (sigPad.parentNode !== stage) stage.appendChild(sigPad);
      sigPad.style.position = 'absolute';
      sigPad.style.left = sigRect.x + 'px';
      sigPad.style.top = sigRect.y + 'px';
      sigPad.style.width = sigRect.w + 'px';
      sigPad.style.height = sigRect.h + 'px';
    } catch(e){
      console.warn('[sig] resizeStage reparent error', e);
    }

    // default: hide canvas until signing enabled
    if (!docLocked) {
      sigPad.classList.add('hidden');
      sigPad.style.pointerEvents = 'none';
    } else {
      sigPad.classList.remove('hidden');
      sigPad.style.pointerEvents = 'auto';
    }

    redraw();
  }
  window.addEventListener('resize', resizeStage);

  function redraw(){
    dCtx.clearRect(0,0,stageW,stageH);
    if(!imgBitmap) return;
    dCtx.save();
    dCtx.setTransform(scale,0,0,scale,offsetX,offsetY);
    dCtx.drawImage(imgBitmap, 0, 0);
    dCtx.restore();
  }

  function fitToStage(){
    if(!imgBitmap) return;
    const s = Math.min(stageW / imgBitmap.naturalWidth, stageH / imgBitmap.naturalHeight);
    scale = s;
    offsetX = Math.floor((stageW - imgBitmap.naturalWidth*scale)/2);
    offsetY = Math.floor((stageH - imgBitmap.naturalHeight*scale)/2);
    minScale = s*0.35;
    maxScale = s*6;
    redraw();
  }

  // Build preview url from server JSON response (handles imagePath/fullPath/filename)
  function buildPreviewUrlFromServerResp(json){
    if(!json) return null;
    if(json.imagePath) return (json.imagePath.startsWith('/') ? window.location.origin + json.imagePath : json.imagePath);
    if(json.fullPath && typeof json.fullPath === 'string'){
      const fn = json.filename || json.fullPath.split(/[\\/]/).pop();
      if(fn && customerId) return `${window.location.origin}/uploads/${encodeURIComponent(customerId)}/${encodeURIComponent(fn)}`;
    }
    if(json.filename && customerId) return `${window.location.origin}/uploads/${encodeURIComponent(customerId)}/${encodeURIComponent(json.filename)}`;
    return null;
  }

  // load image blob into imgBitmap + prepare high-res fullCanvas
  function loadImageFromUrl(url){
    if(!url){ alert('No preview URL provided by server'); statusEl.textContent = 'No preview URL'; return; }
    const absUrl = (url && url.startsWith('/')) ? (window.location.origin + url) : url;
    statusEl.textContent = 'Fetching preview...';
    fetch(absUrl, { method: 'GET' })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        return resp.blob();
      })
      .then(blob => {
        const objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          imgBitmap = img;

          // create fullCanvas at EXPORT_SCALE * native pixels for high-res export
          fullCanvas = document.createElement('canvas');
          fullCanvas.width = Math.max(1, Math.round(img.naturalWidth * EXPORT_SCALE));
          fullCanvas.height = Math.max(1, Math.round(img.naturalHeight * EXPORT_SCALE));
          fCtx = fullCanvas.getContext('2d');

          // draw full-res base image
          fCtx.clearRect(0, 0, fullCanvas.width, fullCanvas.height);
          fCtx.drawImage(img, 0, 0, fullCanvas.width, fullCanvas.height);

          fitToStage();
          URL.revokeObjectURL(objectUrl);
          statusEl.textContent = 'File loaded. Adjust and sign.';
          setTimeout(resizeStage, 40);
        };
        img.onerror = (e) => {
          console.error('img load error', e);
          alert('Error loading image for alignment. Check server logs and ensure the converted file exists and is accessible.');
          statusEl.textContent = 'Error loading image';
        };
        img.src = objectUrl;
      })
      .catch(err => {
        console.error('Failed to fetch preview image:', err);
        alert('Failed to fetch preview image: ' + err.message + '\nCheck convert-pdf response and server logs.');
        statusEl.textContent = 'Failed to fetch preview';
      });
  }

  // handle file input (pdf -> server convert; images -> load directly)
  docInput.addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if(!f) return;
    statusEl.textContent = 'Loading file...';
    if(f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')){
      try {
        const fd = new FormData();
        fd.append('customerId', customerId);
        fd.append('terms', Array.from(termsState).join('-'));
        fd.append('doc', f);
        statusEl.textContent = 'Converting PDF on server...';
        const res = await fetch('/convert-pdf', { method: 'POST', body: fd });
        const json = await res.json();
        if(!json.success) throw new Error(json.error || 'Conversion failed');
        const previewUrl = buildPreviewUrlFromServerResp(json);
        if(!previewUrl) throw new Error('Server returned no usable preview URL');
        loadImageFromUrl(previewUrl);
        uploadedPdfFilename = json.uploadedFilename || null;
        statusEl.textContent = 'PDF converted. Adjust and sign.';
      } catch(err){
        console.error(err);
        alert('PDF conversion failed: ' + err.message);
        statusEl.textContent = 'PDF conversion failed';
      }
    } else {
      const url = URL.createObjectURL(f);
      loadImageFromUrl(url);
      statusEl.textContent = 'Image loaded. Adjust and sign.';
    }
    setTimeout(resizeStage, 80);
  });

  // displayCanvas interaction (panning/zooming). Disabled when docLocked=true
  displayCanvas.addEventListener('pointerdown', e => {
    if (docLocked) return;
    displayCanvas.setPointerCapture && displayCanvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if(pointers.size === 1){ isPanning = true; lastX = e.clientX; lastY = e.clientY; }
  });
  displayCanvas.addEventListener('pointermove', e => {
    if(!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if(pointers.size === 1 && isPanning){
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      offsetX += dx; offsetY += dy; redraw();
    } else if(pointers.size === 2 && !docLocked){
      const pts = Array.from(pointers.values());
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if(!displayCanvas._lastD){ displayCanvas._lastD = d; return; }
      const diff = d - displayCanvas._lastD;
      const zoomFactor = 1 + diff/300;
      applyZoom(zoomFactor, stageW/2, stageH/2);
      displayCanvas._lastD = d;
    }
  });
  displayCanvas.addEventListener('pointerup', e => {
    try { displayCanvas.releasePointerCapture && displayCanvas.releasePointerCapture(e.pointerId); } catch(e){}
    pointers.delete(e.pointerId);
    if(pointers.size < 2) displayCanvas._lastD = null;
    if(pointers.size === 0) isPanning = false;
  });
  displayCanvas.addEventListener('pointercancel', ()=>{ pointers.clear(); isPanning=false; displayCanvas._lastD=null; });

  displayCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (docLocked) return;
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    const rect = displayCanvas.getBoundingClientRect();
    applyZoom(factor, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive:false });

  function applyZoom(factor, cx, cy){
    const newScale = Math.max(minScale, Math.min(maxScale, scale * factor));
    const k = newScale / scale;
    offsetX = cx - k * (cx - offsetX);
    offsetY = cy - k * (cy - offsetY);
    scale = newScale;
    redraw();
  }
  zoomInBtn.addEventListener('click', ()=> applyZoom(1.12, stageW/2, stageH/2));
  zoomOutBtn.addEventListener('click', ()=> applyZoom(0.9, stageW/2, stageH/2));
  resetViewBtn.addEventListener('click', ()=> {
    // If the document is not locked yet, allow full reset (zoom & position reset)
    if (!docLocked) {
      fitToStage();
    }

    // Always clear signature pad (ok to do in both modes)
    if (sigPad && sigPad.getContext) {
      const ctx = sigPad.getContext('2d');
      ctx.clearRect(0,0,sigPad.width,sigPad.height);
    }
  });

  // pen controls
  const penThinBtn = document.getElementById('penThin');
  const penMedBtn = document.getElementById('penMed');
  const penThickBtn = document.getElementById('penThick');

  function applyPenStyle() {
    if (!sigCtx) return;
    const dpr = window.devicePixelRatio || 1;
    let px;
    if (penThickness === 1) px = 2;
    else if (penThickness === 2) px = 4;
    else px = 6;
    // scale line width by dpr so drawing stroke matches visual size on high-DPR devices
    sigCtx.lineWidth = Math.max(1, Math.round(px * dpr));
    sigCtx.lineCap = 'round';
    sigCtx.lineJoin = 'round';
  }

  if (penThinBtn) penThinBtn.addEventListener('click', () => { penThickness = 1; applyPenStyle(); });
  if (penMedBtn) penMedBtn.addEventListener('click', () => { penThickness = 2; applyPenStyle(); });
  if (penThickBtn) penThickBtn.addEventListener('click', () => { penThickness = 3; applyPenStyle(); });

  // convert display coords -> original image pixel coords
  function displayToImage(px, py) {
    return {
      x: (px - offsetX) / scale,
      y: (py - offsetY) / scale
    };
  }

  // Ensure proper stacking and pointer routing when signing
  function ensureSignatureStacking(){
    // make sure displayCanvas doesn't intercept pointers
    try { displayCanvas.style.pointerEvents = 'none'; } catch(e){}
    // sigBox must NOT catch pointer events
    try { sigBoxEl.style.pointerEvents = 'none'; } catch(e){}
    // position and bring sigPad forward
    sigPad.style.position = 'absolute';
    sigPad.style.zIndex = '999999';
    sigPad.style.pointerEvents = 'auto';
    // reparent sigPad into stage for stable positioning
    try { if (sigPad.parentNode !== stage) stage.appendChild(sigPad); } catch(e){}
  }

  // enable signature (attach pointer handlers on sigPad)
  function enableSignaturePad(){
    if (signingEnabled) {
      console.log('[sig] already enabled');
      return;
    }
    console.log('[sig] enableSignaturePad()');
    ensureSignatureStacking();

    signingEnabled = true;
    docLocked = true;

    // compute canvas pixel dims according to sigBox rect and DPR
    const rect = sigBoxEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    sigPad.width = Math.max(1, Math.round(rect.width * dpr));
    sigPad.height = Math.max(1, Math.round(rect.height * dpr));
    sigPad.style.width = rect.width + 'px';
    sigPad.style.height = rect.height + 'px';
    sigPad.style.left = rect.left - stage.getBoundingClientRect().left + 'px';
    sigPad.style.top = rect.top - stage.getBoundingClientRect().top + 'px';
    sigPad.classList.remove('hidden');
    sigPad.style.touchAction = 'none';

    sigCtx = sigPad.getContext('2d');
    sigCtx.setTransform(dpr,0,0,dpr,0,0);
    sigCtx.clearRect(0,0,sigPad.width,sigPad.height);
    sigCtx.strokeStyle = '#000';
    applyPenStyle();

    let drawing = false;

    function getPos(e){
      const r = sigPad.getBoundingClientRect();
      const clientX = (typeof e.clientX === 'number') ? e.clientX : (e.touches && e.touches[0] && e.touches[0].clientX) || 0;
      const clientY = (typeof e.clientY === 'number') ? e.clientY : (e.touches && e.touches[0] && e.touches[0].clientY) || 0;
      return { x: clientX - r.left, y: clientY - r.top };
    }

    function onPointerDown(e){
      if (e.pointerType === 'mouse' && e.button && e.button !== 0) return;
      drawing = true;
      try { sigPad.setPointerCapture && sigPad.setPointerCapture(e.pointerId); } catch(_) {}
      const p = getPos(e);
      sigCtx.beginPath();
      sigCtx.moveTo(p.x, p.y);
      e.preventDefault();
    }
    function onPointerMove(e){
      if(!drawing) return;
      const p = getPos(e);
      sigCtx.lineTo(p.x, p.y);
      sigCtx.stroke();
      e.preventDefault();
    }
    function onPointerUp(e){
      if(!drawing) return;
      drawing = false;
      try { sigPad.releasePointerCapture && sigPad.releasePointerCapture(e.pointerId); } catch(_) {}
      e.preventDefault();
    }

    signatureHandlers = { down: onPointerDown, move: onPointerMove, up: onPointerUp };

    // attach pointer events (primary)
    sigPad.addEventListener('pointerdown', signatureHandlers.down);
    sigPad.addEventListener('pointermove', signatureHandlers.move);
    sigPad.addEventListener('pointerup', signatureHandlers.up);
    sigPad.addEventListener('pointercancel', signatureHandlers.up);
    window.addEventListener('pointerup', signatureHandlers.up);

    // mouse fallback (some environments)
    sigPad.addEventListener('mousedown', signatureHandlers.down);
    sigPad.addEventListener('mousemove', signatureHandlers.move);
    window.addEventListener('mouseup', signatureHandlers.up);

    console.log('[sig] listeners attached; canvas size:', sigPad.width + 'x' + sigPad.height);
  }

  function disableSignaturePad(){
    console.log('[sig] disableSignaturePad()');
    sigPad.classList.add('hidden');
    sigPad.style.pointerEvents = 'none';
    sigPad.style.touchAction = '';
    sigPad.style.zIndex = '';
    signingEnabled = false;
    docLocked = false;

    if (signatureHandlers) {
      try {
        sigPad.removeEventListener('pointerdown', signatureHandlers.down);
        sigPad.removeEventListener('pointermove', signatureHandlers.move);
        sigPad.removeEventListener('pointerup', signatureHandlers.up);
        sigPad.removeEventListener('pointercancel', signatureHandlers.up);
        window.removeEventListener('pointerup', signatureHandlers.up);
        sigPad.removeEventListener('mousedown', signatureHandlers.down);
        sigPad.removeEventListener('mousemove', signatureHandlers.move);
        window.removeEventListener('mouseup', signatureHandlers.up);
      } catch(e){ console.warn('[sig] error removing listeners', e); }
      signatureHandlers = null;
    }

    // restore display canvas to accept pointer events again
    try { displayCanvas.style.pointerEvents = 'auto'; } catch(e){}
  }

  // lock & sign button
  lockAndSignBtn.addEventListener('click', () => {
    console.log('[doc] lockAndSign clicked; imgBitmap?', !!imgBitmap);
    if(!imgBitmap){ alert('Selecione um documento primeiro.'); return; }
    enableSignaturePad();
    lockAndSignBtn.classList.add('hidden');

    if (!document.getElementById('toPreview')) {
      const pv = document.createElement('button'); pv.className='btn'; pv.id='toPreview'; pv.textContent='Pré-visualizar';
      pv.addEventListener('click', buildPreview);
      lockAndSignBtn.parentNode.appendChild(pv);
    }

    statusEl.textContent = 'Assine dentro da área tracejada.';
  });

  // build high-res preview by compositing the signature into fullCanvas
  function buildPreview(){
    if(!fullCanvas || !fCtx){ alert('Documento não carregado.'); return; }

    // redraw base image on fullCanvas
    fCtx.clearRect(0, 0, fullCanvas.width, fullCanvas.height);
    fCtx.drawImage(imgBitmap, 0, 0, fullCanvas.width, fullCanvas.height);

    // signature as image
    const sigDataUrl = sigPad.toDataURL('image/png');
    const sigImg = new Image();
    sigImg.onload = () => {
      // compute signature box in image pixel coords
      const topLeft = displayToImage(sigRect.x, sigRect.y);
      const boxWImg = sigRect.w / scale;
      const boxHImg = sigRect.h / scale;

      // map to fullCanvas pixels
      const sx = Math.round(topLeft.x * EXPORT_SCALE);
      const sy = Math.round(topLeft.y * EXPORT_SCALE);
      const sw = Math.round(boxWImg * EXPORT_SCALE);
      const sh = Math.round(boxHImg * EXPORT_SCALE);

      try {
        fCtx.drawImage(sigImg, 0, 0, sigImg.width, sigImg.height, sx, sy, sw, sh);
      } catch(err) {
        console.warn('[sig] drawImage scaling fallback:', err);
        fCtx.drawImage(sigImg, sx, sy, sw, sh);
      }

      const jpg = fullCanvas.toDataURL('image/jpeg', 0.92);
      previewImg.src = jpg;
      finalImageData = jpg;
      showStep(3);
      statusEl.textContent = 'Pré-visualização pronta';
    };
    sigImg.onerror = (e) => {
      console.error('Signature image load error', e);
      alert('Erro ao processar assinatura');
    };
    sigImg.src = sigDataUrl;
  }

  backToSignBtn.addEventListener('click', ()=> {
    showStep(2);
    statusEl.textContent = '';
  });

  // Save -> POST /save-doc JSON imageData
  saveBtn.addEventListener('click', async () => {
    if (!finalImageData) { alert('Nada para salvar'); return; }
    const selectedTerms = Array.from(termsState);
    const payload = {
      customerId,
      fileName: null, // server will create filename
      imageData: finalImageData,
      terms: selectedTerms.join('-'),
      originalUploadedFilename: uploadedPdfFilename || null
    };

    statusEl.textContent = 'Salvando...';
    try {
      const resp = await fetch('/save-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const text = await resp.text();
      let j;
      try { j = JSON.parse(text); } catch(e){ throw new Error('Server returned non-JSON: ' + text.slice(0,400)); }

      if (!j.success) throw new Error(j.error || 'Save failed');

      let displayPath = j.path || j.fullPath || '';
      if (!displayPath && j.filename && customerId) {
        displayPath = `${window.location.origin}/uploads/${encodeURIComponent(customerId)}/${encodeURIComponent(j.filename)}`;
      }

      saveMessage.textContent = `✅ Saved: ${j.filename || '(no filename)'} — Path: ${displayPath}`;
      statusEl.textContent = 'Saved';
      alert(`Saved successfully\nFile: ${j.filename || '(no filename)'}\nPath: ${displayPath}`);

      if (confirm('Adicionar outro documento?')) {
        const keepCid = customerId;
        resetAll();
        customerIdEl.value = keepCid;
        showStep(1);
      } else {
        window.location.href = './index.html';
      }

    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Save failed';
      alert('Error saving document: ' + err.message);
    }
  });

  // reset internal state and UI
  function resetAll() {
    docInput.value = '';
    imgBitmap = null; fullCanvas = null; fCtx = null; finalImageData = null;
    try { const ctx = sigPad.getContext('2d'); ctx && ctx.clearRect(0, 0, sigPad.width, sigPad.height); } catch(e){}
    disableSignaturePad();
    const pv = document.getElementById('toPreview'); if(pv) pv.remove();
    lockAndSignBtn.classList.remove('hidden');
    previewImg.src = '';
    saveMessage.textContent = '';
    statusEl.textContent = '';
    uploadedPdfFilename = null;
  }

  // initial
  setTimeout(()=>{ resizeStage(); showStep(1); }, 100);

})();
