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
    currentUser: function () { return user; },
    pending: function () { return queue.length; },
    lastUsername: function () { return lsGet(K.last) || ''; },
    demoUsers: function () { return cache.db.users; },

    login: function (username, pin) {
      return call({ action: 'login', username: username, pin: pin }).then(function (r) {
        if (r.ok) {
          token = r.token; user = r.user;
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
      if (!live) return Promise.resolve({ ok: true, db: cache.db, user: user, ver: '' });
      return call({ action: 'state', token: token }).then(function (r) {
        if (r.ok) {
          replayQueue(r.db);
          cache = { db: r.db, ver: r.ver };
          user = r.user; lsSet(K.user, JSON.stringify(user));
        }
        return r;
      }, function () { return { ok: false, offline: true, db: cache && cache.db }; });
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
      return call({ action: action, payload: payload, opId: item.opId, token: token }).then(function (r) {
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
