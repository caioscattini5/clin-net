// sign-fingerprint.js
const fs = require('fs');
const crypto = require('crypto');
if (process.argv.length < 3) {
  console.error('Usage: node sign-fingerprint.js fingerprint.json');
  process.exit(1);
}
const fp = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).fingerprint;
if (!fp) { console.error('No fingerprint found in JSON'); process.exit(1); }
const priv = fs.readFileSync('private.pem', 'utf8');
const sign = crypto.createSign('SHA256');
sign.update(fp, 'utf8');
sign.end();
const sig = sign.sign(priv);
const sigBase64 = sig.toString('base64');

const license = {
  fingerprint: fp,
  signature: sigBase64,
  issuedTo: 'Cliente XYZ',
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 365*24*3600*1000).toISOString()
};

fs.writeFileSync('license.json', JSON.stringify(license, null, 2), 'utf8');
console.log('license.json created. Send license.json and public.pem to client.');
