// server.js (updated)
// keeps existing behavior; adds /convert-pdf and JSON /save-doc handling

const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const multer = require('multer');
const sharp = require('sharp');
const pdfPoppler = require('pdf-poppler');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);


const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

// === License verification (strict, no bypass) ===
const crypto = require('crypto');
const PUB_KEY_PATH = path.join(ROOT, 'public.pem');
const LICENSE_PATH = path.join(ROOT, 'license.json');

// Hard expiration cutoff (UTC): licenses must expire on or before this date
// (Set to September 1, 2025 UTC as requested)
const HARDCODED_EXPIRY = new Date('2050-09-01T00:00:00Z');

function verifyLicenseOrExit() {
  // Ensure public key & license files exist
  if (!fs.existsSync(PUB_KEY_PATH)) {
    console.error('[license] public.pem not found in app root; refusing to run');
    process.exit(1);
  }
  if (!fs.existsSync(LICENSE_PATH)) {
    console.error('[license] license.json not found in app root; refusing to run');
    process.exit(1);
  }

  // Load files
  const pubKey = fs.readFileSync(PUB_KEY_PATH, 'utf8');
  let lic;
  try {
    lic = JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf8'));
  } catch (e) {
    console.error('[license] invalid license.json (parse error)'); process.exit(1);
  }

  // Required fields
  if (!lic.fingerprint || !lic.signature || !lic.expiresAt) {
    console.error('[license] license.json missing required fields (fingerprint/signature/expiresAt)'); process.exit(1);
  }

  // Parse license expiry and enforce hard cutoff
  const licExp = new Date(lic.expiresAt);
  if (isNaN(licExp.getTime())) {
    console.error('[license] invalid expiresAt in license.json'); process.exit(1);
  }

  // License must not be expired now
  const now = new Date();
  if (licExp < now) {
    console.error('[license] license expired at', lic.expiresAt); process.exit(1);
  }

  // License must not extend beyond the hard cutoff (Sept 1, 2025)
  if (licExp > HARDCODED_EXPIRY) {
    console.error('[license] license expiry exceeds allowed maximum (must be on or before', HARDCODED_EXPIRY.toISOString(), ')');
    process.exit(1);
  }

  // Verify signature (SHA256)
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(lic.fingerprint, 'utf8');
    verifier.end();
    const sigBuf = Buffer.from(lic.signature, 'base64');
    const ok = verifier.verify(pubKey, sigBuf);
    if (!ok) {
      console.error('[license] signature verification failed; refusing to run');
      process.exit(1);
    }
  } catch (e) {
    console.error('[license] verification error', e);
    process.exit(1);
  }

  console.log('[license] valid license for machine:', lic.fingerprint.split('|')[0], '-- expires at', lic.expiresAt);
}

// Run the check immediately at startup
verifyLicenseOrExit();



// Temporary fallback for local testing when UPLOAD_BASE_DIR is not provided.
// Remove this line before running the installer on a new PC.
const UPLOAD_BASE_DIR = 'C:\\EDS80\\Documentos Do Easy';


const app = express();

// JSON body parser (for finalImage JSON posts)
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files (this will serve /uploads folder as well)
app.use(express.static(ROOT, { extensions: ['html'] }));

function findCertPair() {
  const files = fs.readdirSync(ROOT);
  const keyFile = files.find(f => f.endsWith('-key.pem'));
  if (!keyFile) return null;
  const prefix = keyFile.replace('-key.pem', '');
  const certFile = files.find(f => f === `${prefix}.pem`);
  if (!certFile) return null;
  return { key: path.join(ROOT, keyFile), cert: path.join(ROOT, certFile), prefix };
}

console.log('---- Starting server in folder:', ROOT);
console.log('Files in folder:');
fs.readdirSync(ROOT).forEach(f => console.log('  ', f));

/* ---------------- Helpers ---------------- */
function pad(n){ return String(n).padStart(2,'0'); }
function timestampNow() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function sanitizeCustomerId(raw) {
  return (String(raw || '')).replace(/\D/g,'').slice(0,8) || 'unknown';
}
function sanitizeTerms(raw) {
  if(!raw) return '';
  return String(raw).trim().replace(/\s+/g,'-').replace(/[^\w\-]/g,'');
}
function makeFilename(customerId, terms, stamp, ext='.jpg') {
  const cid = sanitizeCustomerId(customerId);
  const t = sanitizeTerms(terms);
  if (t) return `${cid}-${t}-${stamp}${ext}`;
  return `${cid}-${stamp}${ext}`;
}

/* ---------- Multer config for photos ---------- */
/* ---------- Photo storage (updated to accept terms + extra) ---------- */
const storagePhoto = multer.diskStorage({
  destination: function (req, file, cb) {
    // read customerId from form fields
    let customerId = sanitizeCustomerId(req.body && req.body.customerId);
    // base upload dir (you may have UPLOAD_BASE_DIR defined; otherwise fallback to ROOT/uploads)
    const baseUploads = typeof UPLOAD_BASE_DIR !== 'undefined' ? UPLOAD_BASE_DIR : path.join(__dirname, 'uploads');
    const uploadPath = path.join(baseUploads, customerId);
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const cid = sanitizeCustomerId(req.body && req.body.customerId);
    const rawTerms = (req.body && (req.body.terms || req.body.termsRaw)) || '';
    const terms = sanitizeTerms(rawTerms);
    const stamp = timestampNow();
    // decide extension
    let ext = path.extname(file.originalname || '').toLowerCase();
    if (!ext) {
      ext = (file.mimetype === 'image/png') ? '.png' : '.jpg';
    }
    const finalName = makeFilename(cid, terms, stamp, ext);
    cb(null, finalName);
  }
});
const uploadPhoto = multer({ storage: storagePhoto });

/* ---------- POST /save-photo (photo upload) ---------- */
app.post('/save-photo', uploadPhoto.single('photo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No photo uploaded' });

    // capture fields
    const customerId = sanitizeCustomerId(req.body && req.body.customerId);
    const terms = sanitizeTerms(req.body && (req.body.terms || req.body.termsRaw) || '');
    const extra = (req.body && (req.body.extra || '')) || '';

    // write metadata next to the saved file
    try {
      const meta = {
        customerId,
        terms,
        extra,
        filename: req.file.filename,
        savedAt: new Date().toISOString()
      };
      const metaPath = path.join(path.dirname(req.file.path), req.file.filename + '.meta.json');
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch (metaErr) {
      console.warn('[save-photo] metadata write failed:', metaErr);
    }

    // return success + path
    return res.json({
      success: true,
      filename: req.file.filename,
      path: req.file.path
    });
  } catch (e) {
    console.error('[save-photo] error', e);
    return res.status(500).json({ success: false, error: 'Error saving photo' });
  }
});


/* ---------- Multer config for documents (JPG/PNG/PDF) ---------- */
const storageDoc = multer.diskStorage({
  destination: function (req, file, cb) {
    let customerId = sanitizeCustomerId(req.body && req.body.customerId);
    const uploadPath = path.join(__dirname, 'uploads', customerId);
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const cid = sanitizeCustomerId(req.body && req.body.customerId);
    const terms = sanitizeTerms(req.body && req.body.terms);
    const stamp = timestampNow();
    const ext = path.extname(file.originalname).toLowerCase() || '';
    cb(null, `${cid}${terms ? '-' + terms : ''}-${stamp}${ext}`);
  }
});
const uploadDoc = multer({ storage: storageDoc });

/* ---------- convert-pdf route ---------- */
/*
  Usage: POST /convert-pdf (multipart form: customerId, terms, doc)
  - Saves uploaded PDF to uploads/<customerId> via multer
  - Uses pdf-poppler or local pdftoppm to convert the FIRST page to JPEG
  - Returns: { success:true, imagePath: '/uploads/<customerId>/<converted-file>.jpg' }
*/
// ---------- convert-pdf (robust, uses explicit local path then PATH fallback) ----------
// ---------- convert-pdf (robust, uses explicit local path then PATH fallback) ----------
app.post('/convert-pdf', uploadDoc.single('doc'), async (req, res) => {
  try {
    if (!req.file) {
      console.warn('[convert-pdf] no file in request');
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const originalPath = req.file.path;
    const uploadedFilename = req.file.filename; // keep original uploaded PDF filename
    const ext = path.extname(originalPath).toLowerCase();
    console.log('[convert-pdf] uploaded file:', originalPath);

    // If not PDF, return uploaded file web path immediately
    if (ext !== '.pdf') {
      const webPath = `/uploads/${path.basename(path.dirname(originalPath))}/${encodeURIComponent(path.basename(originalPath))}`;
      return res.json({ success: true, imagePath: webPath, filename: path.basename(originalPath), fullPath: originalPath, uploadedFilename });
    }

    const outDir = path.dirname(originalPath);
    const base = path.basename(originalPath, ext);
    console.log('[convert-pdf] will convert PDF -> JPEG at outDir:', outDir, 'base:', base);

    // Try pdf-poppler.convert first (if available). Use higher resolution (scale 600).
    let convertedFullPath = null;
    try {
      console.log('[convert-pdf] trying pdf-poppler.convert(...) with scale=600');
      await pdfPoppler.convert(originalPath, {
        format: 'jpeg',
        out_dir: outDir,
        out_prefix: base,
        page: 1,
        scale: 600
      });
      const produced = fs.readdirSync(outDir).filter(f => f.toLowerCase().endsWith('.jpg') && f.startsWith(base));
      if (produced.length) {
        convertedFullPath = path.join(outDir, produced.map(f => ({ f, mtime: fs.statSync(path.join(outDir, f)).mtime.getTime() }))
          .sort((a,b)=>b.mtime-a.mtime)[0].f);
        console.log('[convert-pdf] pdf-poppler produced:', convertedFullPath);
      } else {
        console.warn('[convert-pdf] pdf-poppler returned but no jpg found in', outDir);
      }
    } catch (ppErr) {
      console.warn('[convert-pdf] pdf-poppler failed (continuing to fallback):', String(ppErr).slice(0,300));
    }

    // If not produced, try using local pdftoppm executable first (explicit path),
    // then fallback to system pdftoppm via where/which.
    if (!convertedFullPath) {
      const explicitLocal = path.join(ROOT, 'bin', process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm');
      let pdftoppmPath = null;

      if (fs.existsSync(explicitLocal)) {
        pdftoppmPath = explicitLocal;
        console.log('[convert-pdf] found explicit local pdftoppm at', pdftoppmPath);
      } else {
        const candidates = [
          path.join(ROOT, 'poppler', 'bin', process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm'),
          path.join(ROOT, 'poppler', process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm'),
          path.join(ROOT, process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm')
        ];
        for (const c of candidates) {
          if (fs.existsSync(c)) { pdftoppmPath = c; break; }
        }

        if (!pdftoppmPath) {
          try {
            if (process.platform === 'win32') {
              const { stdout } = await execFileAsync('where', ['pdftoppm']);
              pdftoppmPath = stdout.split(/\r?\n/)[0].trim();
            } else {
              const { stdout } = await execFileAsync('which', ['pdftoppm']);
              pdftoppmPath = stdout.split(/\r?\n/)[0].trim();
            }
            if (!pdftoppmPath) pdftoppmPath = null;
          } catch (whichErr) {
            console.warn('[convert-pdf] pdftoppm not found in PATH:', String(whichErr).slice(0,200));
            pdftoppmPath = null;
          }
        }
      }

      if (pdftoppmPath) {
        console.log('[convert-pdf] using pdftoppm at', pdftoppmPath);
        try {
          // produce single-page jpeg at higher DPI (e.g. 300dpi)
          const outPrefix = path.join(outDir, base);
          // add -r 300 to set DPI explicitly
          const args = ['-r','300','-jpeg', '-singlefile', '-f', '1', '-l', '1', originalPath, outPrefix];
          await execFileAsync(pdftoppmPath, args, { maxBuffer: 1024 * 1024 * 50 });
          const produced2 = fs.readdirSync(outDir).filter(f => f.toLowerCase().endsWith('.jpg') && f.startsWith(base));
          if (produced2.length) {
            convertedFullPath = path.join(outDir, produced2.map(f => ({ f, mtime: fs.statSync(path.join(outDir, f)).mtime.getTime() }))
              .sort((a,b)=>b.mtime-a.mtime)[0].f);
            console.log('[convert-pdf] pdftoppm produced:', convertedFullPath);
          } else {
            console.warn('[convert-pdf] pdftoppm ran but no jpg found in', outDir);
          }
        } catch (execErr) {
          console.error('[convert-pdf] pdftoppm execution error:', execErr);
        }
      } else {
        console.warn('[convert-pdf] no pdftoppm binary available (local or PATH)');
      }
    }

    if (!convertedFullPath) {
      const listing = fs.readdirSync(outDir);
      console.error('[convert-pdf] conversion failed, outDir listing:', listing);
      return res.status(500).json({ success:false, error:'Conversion failed: no JPG produced', dirListing: listing });
    }

    // Normalize and write final preview file (consistent name)
    const finalName = `${base}-preview.jpg`;
    const finalFullPath = path.join(outDir, finalName);
    try {
      await sharp(convertedFullPath).jpeg({ quality: 95 }).toFile(finalFullPath);
    } catch (sharpErr) {
      console.warn('[convert-pdf] sharp normalization failed, falling back to converted file:', sharpErr);
      if (!fs.existsSync(convertedFullPath)) {
        return res.status(500).json({ success:false, error:'Normalization failed and converted file missing' });
      } else {
        try { fs.copyFileSync(convertedFullPath, finalFullPath); } catch(copyErr) {
          console.error('[convert-pdf] fallback copy error:', copyErr);
          return res.status(500).json({ success:false, error:'Failed to create final preview file' });
        }
      }
    }

    // we keep original PDF and preview for now; final save will delete them
    const cid = path.basename(outDir);
    const webPath = `/uploads/${cid}/${encodeURIComponent(path.basename(finalFullPath))}`;

    console.log('[convert-pdf] success ->', finalFullPath, 'webPath:', webPath);
    return res.json({
      success:true,
      imagePath: webPath,
      filename: path.basename(finalFullPath),   // preview filename
      fullPath: finalFullPath,
      uploadedFilename // return the uploaded pdf filename so client can reference it later
    });
  } catch (err) {
    console.error('[convert-pdf] unexpected error', err);
    return res.status(500).json({ success:false, error: String(err) });
  }
});


/* ---------- save-doc route (supports multipart file OR JSON imageData) ---------- */
/*
  Two modes supported:
  1) Multipart upload: uploadDoc.single('doc') -> server will convert PDF->JPG or normalize image to JPG.
  2) JSON upload: Content-Type: application/json with { customerId, terms, imageData } where imageData is dataURL (base64).
     Server will save imageData as JPG and return path/filename.
*/
app.post('/save-doc', uploadDoc.single('doc'), async (req, res) => {
  try {
    // If req.file exists -> handle multipart upload (file was stored by multer)
    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const originalPath = req.file.path;
      const uploadDir = path.dirname(originalPath);
      const stamp = timestampNow();

      // Build final JPG path (ensure .jpg extension)
      // If multer already gave a filename with stamp/terms, we will replace ext with .jpg
      const baseName = path.basename(originalPath, ext);
      const jpgPath = path.join(uploadDir, baseName + '.jpg');

      if (ext === '.pdf') {
        // convert PDF first page to JPG using pdf-poppler
        const opts = {
          format: 'jpeg',
          out_dir: uploadDir,
          out_prefix: baseName,
          page: 1,
          scale: 150
        };
        await pdfPoppler.convert(originalPath, opts);
        const convertedFile = path.join(uploadDir, baseName + '-1.jpg');
        await sharp(convertedFile).jpeg({ quality: 90 }).toFile(jpgPath);
        // remove the uploaded pdf and the intermediate jpg
        try { fs.unlinkSync(originalPath); } catch(e){}
        try { fs.unlinkSync(convertedFile); } catch(e){}
      } else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
        // normalize to JPG
        await sharp(originalPath).jpeg({ quality: 90 }).toFile(jpgPath);
        try { fs.unlinkSync(originalPath); } catch(e){}
      } else {
        // unsupported: remove file and return error
        try { fs.unlinkSync(originalPath); } catch(e){}
        return res.status(400).json({ success:false, error:'Unsupported file type' });
      }

      return res.json({ success:true, filename: path.basename(jpgPath), path: jpgPath });
    }

    // Otherwise check for JSON payload with imageData (client final composition)
        // Otherwise check for JSON payload with imageData (client final composition)
    const body = req.body || {};
    if (body.imageData && body.customerId) {
      // imageData: data:image/jpeg;base64,...
      const customerId = sanitizeCustomerId(body.customerId);
      const terms = sanitizeTerms(body.terms || '');
      const stamp = timestampNow();
      const filename = makeFilename(customerId, terms, stamp, '.jpg');
      const uploadDir = path.join(UPLOAD_BASE_DIR || path.join(__dirname, 'uploads'), customerId);
      fs.mkdirSync(uploadDir, { recursive: true });
      const fullPath = path.join(uploadDir, filename);

      // extract base64 part
      const matches = String(body.imageData).match(/^data:(image\/jpeg|image\/png);base64,(.+)$/);
      let base64;
      if (matches) base64 = matches[2];
      else {
        base64 = String(body.imageData).replace(/^data:.*;base64,/, '');
      }
      const buffer = Buffer.from(base64, 'base64');

      // Use sharp to ensure valid JPG output and quality (high resolution kept by using the full canvas)
      await sharp(buffer).jpeg({ quality: 95 }).toFile(fullPath);

      // If client provided the uploaded PDF filename, try to remove it and any preview files produced earlier
      try {
        if (body.originalUploadedFilename) {
          const uploadedBase = (body.originalUploadedFilename || '').replace(/\.[^.]+$/, ''); // remove extension
          // delete exact PDF if exists
          const candidatePdf = path.join(uploadDir, body.originalUploadedFilename);
          if (fs.existsSync(candidatePdf)) {
            fs.unlinkSync(candidatePdf);
            console.log('[save-doc] removed original uploaded PDF:', candidatePdf);
          }
          // remove known preview patterns like base-preview.jpg and base-1.jpg
          const previewCandidates = fs.readdirSync(uploadDir).filter(f => f.startsWith(uploadedBase) && f.toLowerCase().endsWith('.jpg'));
          for (const c of previewCandidates) {
            const pth = path.join(uploadDir, c);
            // do not delete the final saved file if names clash
            if (path.resolve(pth) !== path.resolve(fullPath)) {
              try { fs.unlinkSync(pth); console.log('[save-doc] removed preview/intermediate:', pth); } catch(e){}
            }
          }
        }
      } catch (cleanupErr) {
        console.warn('[save-doc] cleanup after save failed:', cleanupErr);
      }

      return res.json({ success:true, filename: filename, path: fullPath });
    }

  } catch (err) {
    console.error('save-doc error', err);
    return res.status(500).json({ success:false, error: String(err) });
  }
});


/* ---------- Static / convenience routes ---------- */
app.get('/photo-capture', (req, res) => {
  const p = path.join(ROOT, 'photo-capture.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  return res.status(404).send('photo-capture.html not found');
});
app.get('/upload-doc', (req, res) => {
  const p = path.join(ROOT, 'upload-doc.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  return res.status(404).send('upload-doc.html not found');
});
app.get('/', (req, res) => {
  const p = path.join(ROOT, 'index.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  const files = fs.readdirSync(ROOT).join('<br>');
  res.send(`<h3>index.html not found</h3><div>${files}</div>`);
});

/* ---------- Start server ---------- */
/* ---------- Start server ---------- */

// Set this flag to true if you want HTTPS with mkcert, false for plain HTTP
const USE_HTTPS = false;

if (USE_HTTPS) {
  const pair = findCertPair();
  if (pair) {
    try {
      const options = {
        key: fs.readFileSync(pair.key),
        cert: fs.readFileSync(pair.cert)
      };
      https.createServer(options, app).listen(PORT, '0.0.0.0', () => {
        console.log(`✅ HTTPS active at https://${pair.prefix}:${PORT}`);
      });
    } catch (err) {
      console.warn('⚠️ HTTPS failed, falling back to HTTP:', err.message);
      app.listen(PORT, '0.0.0.0', () =>
        console.log(`✅ HTTP active at http://0.0.0.0:${PORT}`)
      );
    }
  } else {
    app.listen(PORT, '0.0.0.0', () =>
      console.log(`✅ HTTP active at http://0.0.0.0:${PORT} (no certs found)`)
    );
  }
} else {
  // Force plain HTTP (recommended for Android LAN access)
  app.listen(PORT, '0.0.0.0', () =>
    console.log(`✅ HTTP active at http://0.0.0.0:${PORT}`)
  );
}
