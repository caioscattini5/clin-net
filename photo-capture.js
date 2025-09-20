// photo-capture.js — capture + preview + upload with terms and extra info

(() => {
  const TERMS = ['PAN','Peri','FI','Núcleo','Coroa','Inicial','Final','PIX','ONF'];
  const $ = id => document.getElementById(id);
  const termsBox = $('termsBox');
  const termOtherEl = $('termOther');
  const customerIdEl = $('customerId');
  const extraInfoEl = $('extraInfo');
  const fileInput = $('fileInput');
  const btnOpenCam = $('btnOpenCam');
  const btnTake = $('btnTake');
  const btnConfirm = $('btnConfirm');
  const btnRetake = $('btnRetake');
  const btnBack = $('btnBack');
  const previewImg = $('previewImg');
  const previewArea = $('previewArea');
  const afterControls = $('afterControls');
  const statusEl = $('status');

  function renderTerms(){
    termsBox.innerHTML = '';
    TERMS.forEach(t => {
      const lab = document.createElement('label');
      lab.className = 'chip';
      lab.innerHTML = `<input type="checkbox" value="${t}"/> <span>${t}</span>`;
      termsBox.appendChild(lab);
    });
  }
  renderTerms();

  function getSelectedTerms(){
    const arr = Array.from(termsBox.querySelectorAll('input:checked')).map(i => i.value);
    const other = termOtherEl.value.trim();
    if (other) arr.push(other);
    return arr;
  }

  function sanitizeCustomerId(v){
    return String(v || '').replace(/\D/g,'').slice(0,8) || '';
  }

  // open native file picker (camera on mobile)
  btnOpenCam.addEventListener('click', (e) => {
    e.preventDefault();
    fileInput.click();
  });

  // take/select (same as open)
  btnTake.addEventListener('click', (e) => {
    e.preventDefault();
    fileInput.click();
  });

  // retake
  btnRetake.addEventListener('click', (e) => {
    e.preventDefault();
    previewImg.src = '';
    previewArea.style.display = 'none';
    afterControls.style.display = 'none';
    statusEl.textContent = '';
    fileInput.value = '';
  });

  // back to main (index)
  btnBack.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.href = './index.html';
  });

  // when user selects a file/camera result
  fileInput.addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    // basic validation
    const cid = sanitizeCustomerId(customerIdEl.value);
    if (!cid) { alert('Informe o ID do cliente antes de continuar.'); fileInput.value = ''; return; }

    // Accept images only
    if (!f.type.startsWith('image/')) { alert('Por favor selecione uma imagem (jpg/png).'); fileInput.value=''; return; }

    statusEl.textContent = 'Carregando imagem...';
    const obj = URL.createObjectURL(f);
    previewImg.onload = () => {
      URL.revokeObjectURL(obj);
      previewArea.style.display = 'block';
      afterControls.style.display = 'flex';
      statusEl.textContent = 'Confirme a foto ou tire outra.';
    };
    previewImg.src = obj;

    // store file on the element for confirm step
    previewImg._file = f;
  });

  // Confirm & save
  btnConfirm.addEventListener('click', async (e) => {
    e.preventDefault();
    const cid = sanitizeCustomerId(customerIdEl.value);
    if (!cid) { alert('Informe o ID do cliente.'); return; }
    if (!previewImg._file) { alert('Nenhuma foto selecionada.'); return; }

    const selectedTerms = getSelectedTerms();
    const termsJoined = selectedTerms.join('-'); // server will sanitize
    const extra = extraInfoEl.value.trim();

    statusEl.textContent = 'Enviando...';

    const fd = new FormData();
    fd.append('customerId', cid);
    fd.append('terms', termsJoined);
    fd.append('extra', extra);
    fd.append('photo', previewImg._file, previewImg._file.name || 'photo.jpg');

    try {
      const resp = await fetch('/save-photo', { method: 'POST', body: fd });
      const json = await resp.json();
      if (!json || !json.success) {
        throw new Error((json && json.error) || 'Server error');
      }
      statusEl.textContent = `✅ Saved: ${json.filename} — Path: ${json.path}`;
      alert(`Saved successfully\nFile: ${json.filename}\nPath: ${json.path}`);
      // reset UI for next capture (keep customer id)
      const keepCid = cid;
      customerIdEl.value = keepCid;
      termOtherEl.value = '';
      Array.from(termsBox.querySelectorAll('input')).forEach(i => i.checked = false);
      extraInfoEl.value = '';
      previewImg.src = '';
      previewImg._file = null;
      previewArea.style.display = 'none';
      afterControls.style.display = 'none';
      fileInput.value = '';
    } catch (err) {
      console.error('Upload failed', err);
      statusEl.textContent = 'Upload failed';
      alert('Erro ao salvar foto: ' + err.message);
    }
  });

})();
