// genkeys.js (run one-time on vendor machine)
const { generateKeyPairSync } = require('crypto');
const fs = require('fs');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync('private.pem', privateKey.export({ type:'pkcs1', format:'pem' }));
fs.writeFileSync('public.pem', publicKey.export({ type:'pkcs1', format:'pem' }));
console.log('private.pem and public.pem created');
