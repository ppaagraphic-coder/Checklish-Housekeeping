// Service worker แบบเบา: เปิดแอปได้แม้สัญญาณหลุด (network-first เพื่อไม่ให้ได้โค้ดเก่าค้าง)
var CACHE = 'room-check-v7';
var FILES = ['./', 'index.html', 'style.css', 'config.js', 'core.js', 'demo.js', 'api.js', 'form.js', 'form-header.png', 'app.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', function (e) {
  // cache ทีละไฟล์ ถ้าไฟล์ใดหาย (404) ก็ข้ามไป ไม่ให้การติดตั้ง service worker ล้มทั้งชุด (เดิมใช้ addAll ทำให้ SW ใหม่ไม่เคยติดตั้ง แอปเลยค้างโค้ดเก่า)
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(FILES.map(function (f) { return c.add(f).catch(function () { /* ข้ามไฟล์ที่ไม่มี */ }); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// เปิดเร็ว: ใช้ไฟล์ในเครื่องก่อน แล้วอัปเดตเบื้องหลัง (เวอร์ชันใหม่จะขึ้นในการเปิดครั้งถัดไป)
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // API ไม่ผ่าน cache
  e.respondWith(caches.match(req).then(function (hit) {
    var net = fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return hit || caches.match('index.html'); });
    return hit || net;
  }));
});
