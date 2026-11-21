/*
 * api.js — ชั้นติดต่อข้อมูล มี 2 โหมดที่หน้าตาเหมือนกัน
 *   โหมดทดลอง : Core.apply ทำงานในเครื่อง เก็บใน localStorage (ไม่ต่อ Sheet)
 *   โหมดจริง   : ส่งไป Apps Script (ผูก Google Sheet) ถ้าสัญญาณหลุดจะเก็บคิวไว้ส่งซ้ำเอง
 */
var Api = (function () {
  'use strict';
  var cfg = window.APP_CONFIG || {};
  var live = /^https?:\/\//.test(cfg.API_URL || '');
  var K = { token: 'rc_token', user: 'rc_user', queue: 'rc_queue', demo: 'rc_demo', last: 'rc_lastuser', db: 'rc_db' };
  var cache = null;      // { db, user, ver } ล่าสุด (ใช้ตอนออฟไลน์/โหมดทดลอง)
  var queue = [];
  var token = '';
  var user = null;
  var ver = '';          // เลขเวอร์ชันข้อมูลล่าสุดที่หน้าจอนี้รู้
  var outbox = [];       // คำสั่งที่แสดงผลบนหน้าจอแล้วแต่ยังไม่ได้ส่ง (รวมส่งเป็นชุดเดียวเพื่อประหยัดเวลา)
  var draining = null;   // promise ขณะกำลังส่ง outbox (ส่งทีละชุดตามลำดับ กดไวแค่ไหนลำดับก็ไม่สลับ)
  var MAX_BATCH = 30;    // ต้องไม่เกิน MAX_BATCH ใน Code.gs
  var batchOk = true;    // เซิร์ฟเวอร์รองรับ action 'batch' หรือไม่ (ถ้ายังเป็นเวอร์ชันเก่าจะถอยไปส่งทีละคำสั่ง)
  var inflight = 0;      // จำนวนคำสั่งที่แสดงผลแล้วแต่ยังส่งไม่เสร็จ
  var primed = null;     // ข้อมูลที่ได้มาพร้อมการเข้าสู่ระบบ (ไม่ต้องโหลดซ้ำ)

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ใช้ต่อได้ แต่ไม่จำค่า */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function saveQueue() { lsSet(K.queue, JSON.stringify(queue)); }

  // ---------- โหมดจริง ----------
  function call(req) {
    return fetch(cfg.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // text/plain ไม่ต้อง preflight ที่ Apps Script ไม่รองรับ
      body: JSON.stringify(req)
    }).then(function (r) { return r.json(); });
  }

  function emit(type, data) { if (api.onEvent) { try { api.onEvent(type, data); } catch (e) { /* ignore */ } } }
  function scoped(db, u) { return Core.scopeDb(db, u); }
  function pushQueue(item) { queue.push(item); saveQueue(); }

  // ส่งคำสั่งที่แสดงผลบนหน้าจอไปแล้ว (optimistic) ไปเซิร์ฟเวอร์เบื้องหลัง
  // คำสั่งที่รออยู่ในขณะที่ชุดก่อนหน้ายังส่งไม่เสร็จ จะถูกรวมเป็นชุดเดียว (action 'batch') เซิร์ฟเวอร์ล็อก/อ่าน/เขียนชีตครั้งเดียว
  // BUSY = ชนล็อกกับคนอื่น, ERROR = ระบบขัดข้องชั่วคราว → ไม่ใช่การปฏิเสธตามกฎ ให้ลองส่งซ้ำ (opId เดิม ส่งซ้ำปลอดภัย)
  var TRANSIENT = { BUSY: 1, ERROR: 1 };
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function idle() { return draining || Promise.resolve(); } // รอให้ทุกอย่างที่ส่งค้างอยู่เสร็จ

  function reqFor(items) {
    if (items.length === 1) return { action: items[0].action, payload: items[0].payload, opId: items[0].opId, token: token };
    return {
      action: 'batch', token: token,
      ops: items.map(function (i) { return { opId: i.opId, action: i.action, payload: i.payload }; })
    };
  }
  // แปลงคำตอบของเซิร์ฟเวอร์เป็นผลรายคำสั่ง (null = ทั้งชุดยังไม่สำเร็จ ต้องดู r.code)
  function perItem(items, r) {
    if (!r.ok) return null;
    if (items.length === 1) return [r];
    return r.results || null;
  }

  function attempt(items, n) {
    return call(reqFor(items)).then(function (r) {
      var done = items.length;
      if (r.code === 'UNKNOWN' && items.length > 1 && batchOk) {
        // เซิร์ฟเวอร์ยังเป็นเวอร์ชันเก่า (ไม่รู้จัก batch) → ส่งทีละคำสั่งแทน
        batchOk = false;
        return sendEach(items);
      }
      var rs = perItem(items, r);
      if (rs) {
        inflight -= done;
        if (r.prev && r.prev === ver && r.ver) ver = r.ver;
        var bad = null;
        rs.forEach(function (x) { if (!x.ok && !bad) bad = x; });
        if (bad) emit('reject', bad); // เซิร์ฟเวอร์ปฏิเสธบางคำสั่งตามกฎ (เช่น มีคนทำไปก่อน) → โหลดข้อมูลจริงมาแทน
        return;
      }
      if (r.code === 'AUTH') { inflight -= done; items.forEach(pushQueue); emit('auth', r); return; }
      if (TRANSIENT[r.code]) {
        if (n < 3) return wait(1500 * (n + 1)).then(function () { return attempt(items, n + 1); });
        inflight -= done; items.forEach(pushQueue); emit('queued', {}); return; // ลองครบแล้ว เก็บไว้ส่งทีหลัง ไม่ย้อนหน้าจอ
      }
      inflight -= done;
      emit('reject', r);
    }, function () {
      inflight -= items.length; items.forEach(pushQueue); emit('queued', {});
    });
  }
  function sendEach(items) {
    var p = Promise.resolve();
    items.forEach(function (it) { p = p.then(function () { return attempt([it], 0); }); });
    return p;
  }
  function sendBatch(items) {
    if (queue.length) { // มีคิวค้างอยู่ ต้องต่อท้ายเพื่อรักษาลำดับ
      inflight -= items.length; items.forEach(pushQueue); return Promise.resolve();
    }
    return batchOk || items.length === 1 ? attempt(items, 0) : sendEach(items);
  }
  function drain() {
    if (draining) return draining;
    function loop() {
      if (!outbox.length) { draining = null; return Promise.resolve(); }
      var items = outbox.splice(0, MAX_BATCH);
      return sendBatch(items).catch(function () { /* ไม่ให้คิวพัง */ }).then(loop);
    }
    draining = Promise.resolve().then(loop); // เริ่มรอบถัดไปของ event loop เพื่อให้คำสั่งที่กดติดกันมารวมชุดเดียวกัน
    return draining;
  }
  function sendBackground(item) {
    inflight++;
    outbox.push(item);
    drain();
  }

  function replayQueue(db) {
    queue.forEach(function (q) { Core.apply(db, { user: q.user, nowMs: Date.now() }, q.action, q.payload); });
  }

  // ---------- โหมดทดลอง ----------
  function loadDemo() {
    var raw = lsGet(K.demo), d = null;
    try { d = raw ? JSON.parse(raw) : null; } catch (e) { d = null; }
    // ทิ้งข้อมูลทดลองที่จำไว้ ถ้าข้ามวัน หรือโครงห้อง/ผู้ใช้ไม่ตรงกับโค้ดปัจจุบัน (กันค้างข้อมูลเก่าหลังอัปเดต)
    var sig = Core.seedRooms().map(function (r) { return r.id; }).join(',') + '|' + Core.seedUsers().map(function (u) { return u.id; }).join(',');
    if (!d || d.day !== Core.dateOf(Date.now()) || d.sig !== sig) {
      d = { day: Core.dateOf(Date.now()), sig: sig, db: Demo.make(Date.now()) };
      lsSet(K.demo, JSON.stringify(d));
    }
    cache = { db: d.db, ver: '', demo: d };
  }
  function saveDemo() { lsSet(K.demo, JSON.stringify(cache.demo)); }

  var api = {
    isLive: live,

    init: function () {
      try { queue = JSON.parse(lsGet(K.queue) || '[]'); } catch (e) { queue = []; }
      token = lsGet(K.token) || '';
      try { user = JSON.parse(lsGet(K.user) || 'null'); } catch (e) { user = null; }
      if (!live) { loadDemo(); user = null; }
    },
    onEvent: null,
    currentUser: function () { return user; },
    pending: function () { return queue.length; },
    lastUsername: function () { return lsGet(K.last) || ''; },
    demoUsers: function () { return cache.db.users; },

    login: function (username, pin) {
      return call({ action: 'login', username: username, pin: pin }).then(function (r) {
        if (r.ok) {
          token = r.token; user = r.user;
          primed = r.state && r.state.ok ? r.state : null;
          lsSet(K.token, token); lsSet(K.user, JSON.stringify(user)); lsSet(K.last, username);
        }
        return r;
      }, function () { return { ok: false, code: 'OFFLINE', message: 'เชื่อมต่อไม่ได้ ตรวจสอบสัญญาณแล้วลองใหม่' }; });
    },
    demoLogin: function (id) {
      var u = null;
      cache.db.users.forEach(function (x) { if (x.id === id) u = x; });
      user = { id: u.id, name: u.name, role: u.role, floors: u.floors };
      return user;
    },
    demoReset: function () {
      lsDel(K.demo);
      var keep = user && user.id;
      loadDemo();
      if (keep) api.demoLogin(keep);
    },
    logout: function () {
      token = ''; user = null;
      lsDel(K.token); lsDel(K.user); lsDel(K.db);
    },

    // คืน { ok, db, user, ver } หรือ { ok:false, offline:true, db } ถ้าเชื่อมต่อไม่ได้
    state: function () {
      if (!live) return Promise.resolve({ ok: true, db: scoped(cache.db, user), user: user, ver: '' });
      function take(r) {
        if (r.ok) {
          r.db = scoped(r.db, r.user);
          replayQueue(r.db);
          cache = { db: r.db, ver: r.ver };
          ver = r.ver;
          user = r.user; lsSet(K.user, JSON.stringify(user));
          lsSet(K.db, JSON.stringify({ uid: user.id, db: r.db })); // ไว้โชว์ทันทีตอนเปิดแอปครั้งหน้า
        }
        return r;
      }
      if (primed) { var p = primed; primed = null; return Promise.resolve(take(p)); }
      // รอให้คำสั่งที่ส่งค้างอยู่เสร็จก่อน ไม่งั้นข้อมูลที่โหลดมาจะย้อนกลับไปเป็นของเก่า
      return idle().then(function () { return call({ action: 'state', token: token }); }).then(take,
        function () { return { ok: false, offline: true, db: cache && cache.db }; });
    },
    version: function () { return ver; },
    // ข้อมูลล่าสุดที่จำไว้ในเครื่อง (ของผู้ใช้คนเดียวกัน) ใช้โชว์หน้าจอทันทีตอนเปิดแอป ระหว่างรอข้อมูลใหม่
    cachedDb: function () {
      if (!live || !user) return null;
      try {
        var d = JSON.parse(lsGet(K.db) || 'null');
        if (!d || d.uid !== user.id || !d.db || !d.db.rooms) return null;
        replayQueue(d.db);
        cache = { db: d.db, ver: '' };
        return d.db;
      } catch (e) { return null; }
    },
    busy: function () { return inflight > 0; },

    // ประวัติการตรวจของวันที่เลือก พร้อมลายเซ็น (เฉพาะแอดมิน) → { ok, date, inspections, steps, issues }
    history: function (date) {
      if (!live) {
        var db = cache.db, ids = {};
        var insp = db.inspections.filter(function (i) { return i.date === date; });
        insp.forEach(function (i) { ids[i.id] = 1; });
        return Promise.resolve({
          ok: true, date: date, inspections: insp,
          steps: db.steps.filter(function (x) { return ids[x.inspectionId]; }),
          issues: db.issues.filter(function (x) { return ids[x.inspectionId]; })
        });
      }
      return idle().then(function () { return call({ action: 'history', date: date, token: token }); })
        .catch(function () { return { ok: false, offline: true, message: 'เชื่อมต่อไม่ได้ ตรวจสอบสัญญาณแล้วลองใหม่' }; });
    },

    // สรุปตัวเลขย้อนหลัง (เฉพาะแอดมิน) → { ok, data } ; โหมดทดลองคำนวณจากข้อมูลในเครื่อง
    dashboard: function (days) {
      if (!live) return Promise.resolve({ ok: true, days: days, data: Core.dashboard(cache.db, Date.now(), days) });
      return idle().then(function () { return call({ action: 'dashboard', days: days, token: token }); })
        .catch(function () { return { ok: false, offline: true, message: 'เชื่อมต่อไม่ได้ ตรวจสอบสัญญาณแล้วลองใหม่' }; });
    },

    ping: function () {
      if (!live) return Promise.resolve({ ok: true, ver: '' });
      return call({ action: 'ping', token: token }).catch(function () { return { ok: false, offline: true }; });
    },

    // ส่งคำสั่ง → { ok, result } | { ok:false, code, message } | { ok:true, queued:true }
    act: function (action, payload) {
      payload = payload || {};
      if (!live) {
        var r = Core.apply(cache.db, { user: user, nowMs: Date.now() }, action, payload);
        if (r.ok) saveDemo();
        return Promise.resolve({ ok: r.ok, code: r.code, message: r.message, result: r.result });
      }
      var item = { opId: uid(), action: action, payload: payload, user: user };
      // ถ้ายังมีคิวค้างอยู่ ต้องต่อท้ายคิวเพื่อรักษาลำดับ
      if (queue.length) return enqueue(item);

      // ลองทำในเครื่องก่อน ถ้าผ่านกฎ → แสดงผลทันที แล้วส่งไปเซิร์ฟเวอร์เบื้องหลัง (ไม่ต้องรอ 1–3 วินาที)
      if (cache && cache.db) {
        var local = Core.apply(cache.db, { user: user, nowMs: Date.now() }, action, payload);
        if (local.ok) {
          sendBackground(item);
          return Promise.resolve({ ok: true, result: local.result, optimistic: true });
        }
        // กฎ "ต้องยืนยันก่อน" ตอบได้ทันทีจากข้อมูลในเครื่อง
        if (local.code === 'NEEDS_CONFIRM') return Promise.resolve({ ok: false, code: local.code, message: local.message });
      }
      // ไม่ผ่านกฎในเครื่อง → ให้เซิร์ฟเวอร์ตัดสิน (ข้อมูลในเครื่องอาจเก่า) หลังคำสั่งก่อนหน้าส่งเสร็จ
      return idle().then(function () {
        return call({ action: action, payload: payload, opId: item.opId, token: token });
      }).then(function (r) {
        if (r.ok && r.prev && r.prev === ver && r.ver) ver = r.ver;
        return r;
      }, function () { return enqueue(item); });
    },

    // ส่งคิวที่ค้าง → { sent, dropped:[ข้อความ] } (ส่งเป็นชุด ชุดละไม่เกิน MAX_BATCH)
    flush: function () {
      var res = { sent: 0, dropped: [] };
      if (!live || !queue.length) return Promise.resolve(res);
      function next(size) {
        if (!queue.length) return Promise.resolve(res);
        if (!batchOk) size = 1;
        var items = queue.slice(0, size);
        return call(reqFor(items)).then(function (r) {
          if (r.code === 'UNKNOWN' && items.length > 1) { batchOk = false; return next(1); } // เซิร์ฟเวอร์เวอร์ชันเก่า
          if (r.code === 'AUTH' || r.code === 'BUSY') return res; // รอเข้าสู่ระบบใหม่/รอล็อกว่าง ไม่ทิ้งคิว
          var rs = perItem(items, r);
          if (rs) {
            queue.splice(0, items.length); saveQueue();
            rs.forEach(function (x) { if (x.ok) res.sent++; else res.dropped.push(x.message || 'ส่งรายการไม่สำเร็จ'); });
            return next(MAX_BATCH);
          }
          if (r.code === 'ERROR') {
            if (items.length > 1) return next(1); // แยกส่งทีละคำสั่ง จะได้รู้ว่าตัวไหนเป็นปัญหา
            var q = items[0];
            q.tries = (q.tries || 0) + 1;
            if (q.tries < 5) { saveQueue(); return res; }
          }
          queue.shift(); saveQueue();
          res.dropped.push(r.message || 'ส่งรายการไม่สำเร็จ');
          return next(MAX_BATCH);
        }, function () { return res; });
      }
      return next(MAX_BATCH);
    }
  };

  function enqueue(item) {
    queue.push(item); saveQueue();
    if (cache && cache.db) Core.apply(cache.db, { user: item.user, nowMs: Date.now() }, item.action, item.payload);
    return Promise.resolve({ ok: true, queued: true });
  }

  api.uid = uid;
  return api;
})();
