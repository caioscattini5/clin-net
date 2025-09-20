installation

cli-net

C:\myapp
  ├─ server.js
  ├─ index.html                (main menu)
  ├─ upload-doc.html           (new page)
  ├─ upload-doc.js             (logic)
  ├─ public/                   (optional; if you prefer)
  ├─ uploads\                  (created by server; holds saved files)
  ├─ 192.168.15.12.pem         (or your mkcert cert)
  ├─ 192.168.15.12-key.pem     (or your mkcert key)
  └─ lib/
       └─ pdfjs/               (optional; pdf.min.js + pdf.worker.min.js)


mkcert
1. npm install express multer
2. 