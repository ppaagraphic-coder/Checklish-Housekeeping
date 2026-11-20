/*
 * api.js — ชั้นติดต่อข้อมูล มี 2 โหมดที่หน้าตาเหมือนกัน
 *   โหมดทดลอง : Core.apply ทำงานในเครื่อง เก็บใน localStorage (ไม่ต่อ Sheet)
 *   โหมดจริง   : ส่งไป Apps Script (ผูก Google Sheet) ถ้าสัญญาณหลุดจะเก็บคิวไว้ส่งซ้ำเอง
 */
var Api = (function () {
  'use strict';
  var cfg = window.APP_CONFIG || {};
  var live = /^https?:\/\//.test(cfg.API_URL || '');
  var K = { token: 'rc_token', user: 'rc_user', queue: 'rc_queue', demo: 'rc_demo', last: 'rc_lastuser' };
  var cache = null;      // { db, user, ver } ล่าสุด (ใช้ตอนออฟไลน์/โหมดทดลอง)
  var queue = [];
  var token = '';
  var user = null;
  var ver = '';          // เลขเวอร์ชันข้อมูลล่าสุดที่หน้าจอนี้รู้
  var chain = Promise.resolve(); // คิวส่งคำสั่งไปเซิร์ฟเวอร์ทีละคำสั่งตามลำดับ (กดไวแค่ไหนลำดับก็ไม่สลับ)
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
  function sendBackground(item) {
    inflight++;
    chain = chain.then(function () {
      if (queue.length) { pushQueue(item); inflight--; return; } // มีคิวออฟไลน์ค้างอยู่ ต้องต่อท้ายเพื่อรักษาลำดับ
      return call({ action: item.action, payload: item.payload, opId: item.opId, token: token }).then(function (r) {
        inflight--;
        if (r.ok) { if (r.prev && r.prev === ver && r.ver) ver = r.ver; return; }
        if (r.code === 'AUTH') { pushQueue(item); emit('auth', r); return; }
        emit('reject', r); // เซิร์ฟเวอร์ปฏิเสธ (เช่น มีคนทำไปก่อน) → หน้าจอจะโหลดข้อมูลจริงมาแทน
      }, function () {
        inflight--; pushQueue(item); emit('queued', {});
      });
    }).catch(function () { /* ไม่ให้คิวพัง */ });
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
      lsDel(K.token); lsDel(K.user);
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
        }
        return r;
      }
      if (primed) { var p = primed; primed = null; return Promise.resolve(take(p)); }
      // รอให้คำสั่งที่ส่งค้างอยู่เสร็จก่อน ไม่งั้นข้อมูลที่โหลดมาจะย้อนกลับไปเป็นของเก่า
      return chain.then(function () { return call({ action: 'state', token: token }); }).then(take,
        function () { return { ok: false, offline: true, db: cache && cache.db }; });
    },
    version: function () { return ver; },
    busy: function () { return inflight > 0; },

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
      return chain.then(function () {
        return call({ action: action, payload: payload, opId: item.opId, token: token });
      }).then(function (r) {
        if (r.ok && r.prev && r.prev === ver && r.ver) ver = r.ver;
        return r;
      }, function () { return enqueue(item); });
    },

    // ส่งคิวที่ค้าง → { sent, dropped:[ข้อความ] }
    flush: function () {
      var res = { sent: 0, dropped: [] };
      if (!live || !queue.length) return Promise.resolve(res);
      function next() {
        if (!queue.length) return Promise.resolve(res);
        var q = queue[0];
        return call({ action: q.action, payload: q.payload, opId: q.opId, token: token }).then(function (r) {
          if (r.code === 'AUTH') return res; // รอเข้าสู่ระบบใหม่ ไม่ทิ้งคิว
          queue.shift(); saveQueue();
          if (r.ok) res.sent++; else res.dropped.push(r.message || 'ส่งรายการไม่สำเร็จ');
          return next();
        }, function () { return res; });
      }
      return next();
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
