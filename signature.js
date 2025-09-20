// signature.js — minimal shim so upload-doc.html can load without 404
// If you already have a full signature implementation in signature.js, replace this stub with your real file.

(function () {
  // small helper to expose a no-op Signature API if needed by other scripts
  window.Signature = window.Signature || {
    // placeholder: open signature modal or perform signature capture
    start: function () {
      console.log('[Signature] start() called (stub)');
    },
    clear: function () {
      console.log('[Signature] clear() called (stub)');
    },
    getDataURL: function () {
      console.log('[Signature] getDataURL() called (stub)');
      return null;
    }
  };

  // small console hint so we can detect it loaded
  console.log('signature.js loaded (stub)');
})();
