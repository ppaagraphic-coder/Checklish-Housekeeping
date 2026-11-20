/*
 * core.js — ตรรกะ workflow กลางของระบบตรวจเช็กห้องพัก
 *
 * ไฟล์นี้ใช้ร่วมกัน 4 ที่ (ห้ามมีกฎซ้ำกันคนละชุด):
 *   1) หน้าเว็บ (ตรวจกฎก่อนส่ง + แสดงผลทันทีขณะรอส่ง)
 *   2) โหมดทดลอง (เก็บข้อมูลในเครื่อง)
 *   3) Google Apps Script (copy ไปเป็น apps-script/Core.gs ด้วย tools/sync-core.js)
 *   4) เทสต์ (test/core.test.js)
 *
 * หลักการ: apply(db, ctx, action, payload) ตรวจสิทธิ์/สถานะก่อนแก้ข้อมูล
 * ถ้าผิดกฎจะไม่แก้อะไรเลย และคืน { ok:false, code, message }
 */
var Core = (function () {
  'use strict';

  // ---------- ค่าคงที่ ----------
  var ROLES = {
    admin: 'ผู้ดูแลระบบ',
    maid: 'แม่บ้านประจำชั้น',
    head_maid: 'หัวหน้าแม่บ้าน',
    reception: 'หัวหน้าฝ่ายต้อนรับ'
  };
  // ใครตรวจขั้นไหน — ถ้าอยากให้ admin ตรวจแทนได้ ให้แก้ตรงนี้ที่เดียว
  var STEP_ROLE = { 1: 'maid', 2: 'head_maid', 3: 'reception' };
  var STEP_LABEL = { 1: 'แม่บ้านประจำชั้น', 2: 'หัวหน้าแม่บ้าน', 3: 'หัวหน้าฝ่ายต้อนรับ (QC)' };
  var ROOM_STATUS = {
    ready: 'พร้อมขาย',
    occupied: 'มีแขกพัก',
    dirty: 'รอทำความสะอาด',
    inspecting: 'รอตรวจ',
    issue: 'มีปัญหา'
  };
  var ROUNDS = { morning: 'รอบเช้า', afternoon: 'รอบบ่าย' };
  var KIND_LABEL = { missing: 'ขาด/สูญหาย', damaged: 'ชำรุด' };

  // 25 รายการตามฟอร์มกระดาษ [ชื่อ, จำนวนมาตรฐาน]
  var DEFAULT_ITEMS = [
    ['รองเท้า', 2], ['กระจกส่องหน้า', 1], ['เสื้อคลุม', 2], ['ผ้าเช็ดตัว/เช็ดผม/เช็ดเท้า', 3],
    ['ไดร์เป่าผม/ถุงไดร์', 1], ['ไฟฉาย/ถุงไฟฉาย', 1], ['รีโมททีวี', 1], ['โทรศัพท์', 1],
    ['แก้วไวน์', 2], ['แก้วแชมเปญ', 2], ['แก้วดำยาว', 2], ['แก้วกาแฟ', 2], ['แก้วสั้น', 2],
    ['น้ำดื่ม', 4], ['เบียร์สิงห์', 2], ['เบียร์ช้าง', 2], ['เป๊ปซี่', 2], ['โซดา', 2],
    ['ชา/กาแฟ', 2], ['ผ้าคลุมเตียง', 1], ['ไม้แขวนเสื้อ', 4], ['ช้อน+ส้อม', 6],
    ['จาน', 6], ['ชาม', 6], ['ช้อนกาแฟ', 5]
  ];

  // โครงชีต Google Sheet (ลำดับคอลัมน์ = ลำดับในชีต)
  var SCHEMA = {
    Users: { cols: ['id', 'name', 'role', 'floors', 'pinHash', 'active', 'lineUserId', 'newPin'], num: ['active'] },
    Rooms: { cols: ['id', 'floor', 'status', 'inspectionId', 'updatedAt'], num: ['floor'] },
    Items: { cols: ['no', 'name', 'qty'], num: ['no', 'qty'] },
    Inspections: {
      cols: ['id', 'roomId', 'type', 'round', 'date', 'status', 'step', 'failedStep', 'recheckItems',
        'startedAt', 'stepSince', 'finishedAt', 'note'],
      num: ['step', 'failedStep']
    },
    Steps: {
      cols: ['inspectionId', 'step', 'userId', 'userName', 'at', 'okCount', 'failCount', 'result', 'mode'],
      num: ['step', 'okCount', 'failCount']
    },
    Issues: {
      cols: ['id', 'inspectionId', 'roomId', 'step', 'itemNo', 'itemName', 'expected', 'found', 'kind', 'note',
        'status', 'reportedBy', 'reportedAt', 'fixedBy', 'fixedAt'],
      num: ['step', 'itemNo', 'expected', 'found']
    },
    Log: { cols: ['at', 'userId', 'userName', 'role', 'action', 'roomId', 'inspectionId', 'detail'] }
  };

  // ---------- เวลา (ไทย UTC+7 ไม่มี DST) ----------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function stamp(ms) {
    var d = new Date(ms + 7 * 3600000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  }
  function dateOf(ms) { return stamp(ms).slice(0, 10); }
  function toMs(s) {
    var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(s || '');
    if (!m) return 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5], +m[6]);
  }
  function minutesSince(s, nowMs) { return Math.max(0, Math.round((nowMs - toMs(s)) / 60000)); }

  // ---------- ข้อผิดพลาด ----------
  function CoreError(code, message) { this.code = code; this.message = message; }
  function err(code, message) { return new CoreError(code, message); }

  // ---------- ตัวช่วยอ่านข้อมูล ----------
  function sid(x) { return String(x); }
  function roomOf(db, id) { for (var i = 0; i < db.rooms.length; i++) if (sid(db.rooms[i].id) === sid(id)) return db.rooms[i]; return null; }
  function inspOf(db, id) { for (var i = 0; i < db.inspections.length; i++) if (db.inspections[i].id === id) return db.inspections[i]; return null; }
  function mustRoom(db, id) { var r = roomOf(db, id); if (!r) throw err('NO_ROOM', 'ไม่พบห้อง ' + id); return r; }
  function mustInsp(db, id) { var i = inspOf(db, id); if (!i) throw err('NO_INSPECTION', 'ไม่พบใบตรวจนี้'); return i; }
  function isActive(i) { return i.status === 'open' || i.status === 'fixing'; }
  function activeInspOf(db, roomId) {
    for (var i = 0; i < db.inspections.length; i++) {
      var x = db.inspections[i];
      if (sid(x.roomId) === sid(roomId) && isActive(x)) return x;
    }
    return null;
  }
  function needRole(ctx, roles) {
    if (!ctx.user || roles.indexOf(ctx.user.role) < 0) throw err('FORBIDDEN', 'บทบาทของคุณไม่มีสิทธิ์ทำรายการนี้');
  }
  function recheckList(insp) {
    return insp.recheckItems ? String(insp.recheckItems).split(',').filter(Boolean).map(Number) : [];
  }

  // ---------- ตัวช่วยแก้ข้อมูล (แก้ db และบันทึก ops ให้ชั้นเก็บข้อมูลเขียนต่อ) ----------
  function put(out, table, row) { out.ops.push({ table: table, row: row }); }
  function setRoom(out, ctx, room, patch) {
    for (var k in patch) room[k] = patch[k];
    room.updatedAt = stamp(ctx.nowMs);
    put(out, 'Rooms', room);
  }
  function log(out, ctx, action, roomId, inspId, detail) {
    put(out, 'Log', {
      at: stamp(ctx.nowMs), userId: ctx.user.id, userName: ctx.user.name, role: ctx.user.role,
      action: action, roomId: roomId || '', inspectionId: inspId || '', detail: detail || ''
    });
  }
  function notify(out, to, roomId, kind, text) { out.notify.push({ to: to, roomId: roomId, kind: kind, text: text }); }
  function newInspection(db, out, ctx, room, type, round, p) {
    var seed = p.idSeed ? String(p.idSeed).replace(/[^A-Za-z0-9]/g, '').slice(0, 12) : ctx.nowMs.toString(36);
    var id = 'I-' + room.id + '-' + seed;
    if (inspOf(db, id)) throw err('DUPLICATE', 'รายการนี้ถูกบันทึกไปแล้ว');
    var now = stamp(ctx.nowMs);
    var insp = {
      id: id, roomId: sid(room.id), type: type, round: round || '', date: dateOf(ctx.nowMs),
      status: 'open', step: 1, failedStep: 0, recheckItems: '', startedAt: now, stepSince: now,
      finishedAt: '', note: ''
    };
    db.inspections.push(insp);
    put(out, 'Inspections', insp);
    return insp;
  }
  function tryEach(fn) {
    try { fn(); return null; } catch (e) { if (e instanceof CoreError) return e.message; throw e; }
  }

  // ---------- คำสั่ง (actions) ----------
  var H = {};

  // แขกเช็กอิน — หัวหน้าฝ่ายต้อนรับ (และ admin)
  H.checkin = function (db, ctx, p, out) {
    needRole(ctx, ['reception', 'admin']);
    var room = mustRoom(db, p.roomId);
    if (room.status === 'occupied') throw err('ALREADY_OCCUPIED', 'ห้อง ' + room.id + ' มีแขกพักอยู่แล้ว');
    var note = '';
    if (room.status !== 'ready') {
      if (!p.force) {
        throw err('NEEDS_CONFIRM', 'ห้อง ' + room.id + ' ยังตรวจไม่ครบ (สถานะ: ' + ROOM_STATUS[room.status] + ') ต้องการให้แขกเข้าพักก่อนหรือไม่?');
      }
      var insp = activeInspOf(db, room.id);
      if (insp) {
        insp.status = 'cancelled';
        insp.finishedAt = stamp(ctx.nowMs);
        insp.note = 'เช็กอินก่อนตรวจครบ โดย ' + ctx.user.name;
        put(out, 'Inspections', insp);
      }
      note = ' (ยืนยันเข้าพักทั้งที่สถานะ: ' + ROOM_STATUS[room.status] + ')';
    }
    setRoom(out, ctx, room, { status: 'occupied', inspectionId: '' });
    log(out, ctx, 'checkin', room.id, '', 'เช็กอิน' + note);
  };

  // แขกเช็กเอาท์ — ห้องกลายเป็น "รอทำความสะอาด"
  H.checkout = function (db, ctx, p, out) {
    needRole(ctx, ['reception', 'admin']);
    var room = mustRoom(db, p.roomId);
    if (room.status !== 'occupied') throw err('NOT_OCCUPIED', 'ห้อง ' + room.id + ' ไม่ได้มีแขกพักอยู่');
    setRoom(out, ctx, room, { status: 'dirty', inspectionId: '' });
    log(out, ctx, 'checkout', room.id, '', 'เช็กเอาท์');
    notify(out, { role: 'maid', floor: room.floor }, room.id, 'checkout', 'ห้อง ' + room.id + ' เช็กเอาท์แล้ว รอทำความสะอาด');
  };

  // แม่บ้านทำความสะอาดเสร็จ — สร้างใบตรวจใหม่ (ตรวจขั้น 1)
  H.cleaned = function (db, ctx, p, out) {
    needRole(ctx, ['maid']);
    var room = mustRoom(db, p.roomId);
    if (room.status !== 'dirty') throw err('NOT_DIRTY', 'ห้อง ' + room.id + ' ไม่ได้อยู่ในสถานะรอทำความสะอาด (' + ROOM_STATUS[room.status] + ')');
    var insp = newInspection(db, out, ctx, room, 'checkout', '', p);
    setRoom(out, ctx, room, { status: 'inspecting', inspectionId: insp.id });
    log(out, ctx, 'cleaned', room.id, insp.id, 'ทำความสะอาดเสร็จ เริ่มตรวจขั้นที่ 1');
    out.result = { inspectionId: insp.id };
  };

  function startRoutineOne(db, ctx, roomId, round, p, out) {
    if (!ROUNDS[round]) throw err('BAD_ROUND', 'รอบตรวจไม่ถูกต้อง');
    var room = mustRoom(db, roomId);
    if (room.status !== 'ready') throw err('NOT_READY', 'ห้อง ' + room.id + ' ไม่ได้ว่างพร้อมขาย (' + ROOM_STATUS[room.status] + ')');
    var today = dateOf(ctx.nowMs);
    for (var i = 0; i < db.inspections.length; i++) {
      var x = db.inspections[i];
      if (sid(x.roomId) === sid(room.id) && x.type === 'routine' && x.round === round && x.date === today && x.status !== 'cancelled') {
        throw err('ALREADY_DONE', 'ห้อง ' + room.id + ' เริ่มตรวจ' + ROUNDS[round] + 'วันนี้ไปแล้ว');
      }
    }
    var insp = newInspection(db, out, ctx, room, 'routine', round, p);
    setRoom(out, ctx, room, { status: 'inspecting', inspectionId: insp.id });
    log(out, ctx, 'start_routine', room.id, insp.id, 'เริ่มตรวจ' + ROUNDS[round]);
    return insp;
  }

  // เริ่มตรวจตามรอบ (เช้า/บ่าย) — เฉพาะห้องว่างพร้อมขาย
  H.startRoutine = function (db, ctx, p, out) {
    needRole(ctx, ['maid', 'head_maid']);
    var insp = startRoutineOne(db, ctx, p.roomId, p.round, p, out);
    out.result = { inspectionId: insp.id };
  };
  H.startRoutineMany = function (db, ctx, p, out) {
    needRole(ctx, ['maid', 'head_maid']);
    var started = [], skipped = [];
    (p.roomIds || []).forEach(function (rid) {
      var msg = tryEach(function () { started.push(startRoutineOne(db, ctx, rid, p.round, p, out).id); });
      if (msg) skipped.push({ roomId: rid, message: msg });
    });
    out.result = { started: started, skipped: skipped };
    if (started.length) {
      notify(out, { role: 'maid' }, '', 'next', 'มีห้องรอตรวจ' + ROUNDS[p.round] + ' ' + started.length + ' ห้อง');
    }
  };

  function normFailures(db, list) {
    var seen = {}, res = [];
    (list || []).forEach(function (f) {
      var item = null;
      for (var i = 0; i < db.items.length; i++) if (Number(db.items[i].no) === Number(f.itemNo)) item = db.items[i];
      if (!item) throw err('BAD_ITEM', 'ไม่พบรายการของใช้ลำดับที่ ' + f.itemNo);
      if (seen[item.no]) return;
      seen[item.no] = 1;
      var qty = Number(item.qty);
      var found = Math.max(0, Math.min(qty - 1, Math.floor(Number(f.found) || 0)));
      res.push({
        item: item, kind: f.kind === 'damaged' ? 'damaged' : 'missing', found: found,
        note: String(f.note || '').slice(0, 200)
      });
    });
    return res;
  }

  function submitStepOne(db, ctx, inspectionId, expectStep, failuresIn, out) {
    var insp = mustInsp(db, inspectionId);
    var room = mustRoom(db, insp.roomId);
    if (insp.status === 'fixing') throw err('NEEDS_FIX', 'ห้อง ' + room.id + ' มีรายการที่ต้องแก้ไขก่อน');
    if (insp.status !== 'open') throw err('CLOSED', 'ใบตรวจห้อง ' + room.id + ' ปิดไปแล้ว');
    var step = Number(insp.step);
    if (expectStep != null && Number(expectStep) !== step) throw err('STALE', 'ห้อง ' + room.id + ' ถูกส่งต่อไปขั้นอื่นแล้ว กรุณารีเฟรช');
    if (ctx.user.role !== STEP_ROLE[step]) throw err('FORBIDDEN', 'ขั้นที่ ' + step + ' เป็นหน้าที่ของ' + STEP_LABEL[step]);
    var fails = normFailures(db, failuresIn);
    var total = db.items.length;
    var recheck = recheckList(insp).length > 0;
    var now = stamp(ctx.nowMs);

    var rec = {
      inspectionId: insp.id, step: step, userId: ctx.user.id, userName: ctx.user.name, at: now,
      okCount: total - fails.length, failCount: fails.length,
      result: fails.length ? 'fail' : 'pass', mode: recheck ? 'recheck' : 'check'
    };
    db.steps.push(rec);
    put(out, 'Steps', rec);

    if (fails.length) {
      fails.forEach(function (f) {
        var n = 1;
        db.issues.forEach(function (x) { if (x.inspectionId === insp.id) n++; });
        var issue = {
          id: insp.id + '-' + step + '-' + f.item.no + '-' + n, inspectionId: insp.id, roomId: sid(room.id), step: step,
          itemNo: Number(f.item.no), itemName: f.item.name, expected: Number(f.item.qty), found: f.found,
          kind: f.kind, note: f.note, status: 'open', reportedBy: ctx.user.name, reportedAt: now, fixedBy: '', fixedAt: ''
        };
        db.issues.push(issue);
        put(out, 'Issues', issue);
      });
      insp.status = 'fixing';
      insp.failedStep = step;
      insp.recheckItems = fails.map(function (f) { return f.item.no; }).join(',');
      insp.stepSince = now;
      put(out, 'Inspections', insp);
      setRoom(out, ctx, room, { status: 'issue' });
      log(out, ctx, 'step_fail', room.id, insp.id, 'ขั้น ' + step + ' พบ ' + fails.length + ' รายการ: ' +
        fails.map(function (f) { return f.item.name; }).join(', '));
      notify(out, { role: 'maid', floor: room.floor }, room.id, 'issue',
        'ห้อง ' + room.id + ' พบปัญหา ' + fails.length + ' รายการ (' + STEP_LABEL[step] + ') กรุณาแก้ไข');
      return { passed: false, failCount: fails.length };
    }

    insp.recheckItems = '';
    insp.failedStep = 0;
    insp.stepSince = now;
    if (step < 3) {
      insp.step = step + 1;
      put(out, 'Inspections', insp);
      log(out, ctx, 'step_pass', room.id, insp.id, 'ผ่านขั้น ' + step + ' ส่งต่อ' + STEP_LABEL[step + 1]);
      notify(out, { role: STEP_ROLE[step + 1] }, room.id, 'next', 'ห้อง ' + room.id + ' รอตรวจขั้นที่ ' + (step + 1));
    } else {
      insp.status = 'passed';
      insp.finishedAt = now;
      put(out, 'Inspections', insp);
      setRoom(out, ctx, room, { status: 'ready', inspectionId: '' });
      log(out, ctx, 'step_pass', room.id, insp.id, 'ผ่านขั้น 3 ห้องพร้อมขาย');
    }
    return { passed: true, failCount: 0 };
  }

  // ส่งผลตรวจ 1 ขั้น — p.failures = [{itemNo, kind, found, note}] (ว่าง = ครบทุกรายการ)
  H.submitStep = function (db, ctx, p, out) {
    out.result = submitStepOne(db, ctx, p.inspectionId, p.step, p.failures, out);
  };

  // ผ่านหลายห้องพร้อมกัน (ไม่มีรายการ ✗) — p.items = [{inspectionId, step}]
  H.bulkPass = function (db, ctx, p, out) {
    var passed = [], skipped = [];
    (p.items || []).forEach(function (it) {
      var msg = tryEach(function () {
        // ตรวจสิทธิ์ก่อนแตะข้อมูล (submitStepOne ตรวจให้อยู่แล้ว)
        submitStepOne(db, ctx, it.inspectionId, it.step, [], out);
        passed.push(it.inspectionId);
      });
      if (msg) skipped.push({ inspectionId: it.inspectionId, message: msg });
    });
    out.result = { passed: passed, skipped: skipped };
  };

  // แม่บ้านแก้ไขรายการที่พบปัญหาแล้ว — ส่งกลับไปตรวจซ้ำเฉพาะรายการนั้นที่ขั้นเดิม
  H.markFixed = function (db, ctx, p, out) {
    needRole(ctx, ['maid', 'head_maid']);
    var insp = mustInsp(db, p.inspectionId);
    var room = mustRoom(db, insp.roomId);
    if (insp.status !== 'fixing') throw err('NOT_FIXING', 'ห้อง ' + room.id + ' ไม่มีรายการที่รอแก้ไข');
    var now = stamp(ctx.nowMs);
    var n = 0;
    db.issues.forEach(function (x) {
      if (x.inspectionId === insp.id && x.status === 'open') {
        x.status = 'fixed'; x.fixedBy = ctx.user.name; x.fixedAt = now; n++;
        put(out, 'Issues', x);
      }
    });
    insp.status = 'open';
    insp.step = insp.failedStep || 1;
    insp.stepSince = now;
    put(out, 'Inspections', insp);
    setRoom(out, ctx, room, { status: 'inspecting' });
    log(out, ctx, 'fixed', room.id, insp.id, 'แก้ไขแล้ว ' + n + ' รายการ ส่งตรวจซ้ำขั้น ' + insp.step);
    notify(out, { role: STEP_ROLE[insp.step], floor: insp.step === 1 ? room.floor : undefined }, room.id, 'fixed',
      'ห้อง ' + room.id + ' แก้ไขแล้ว รอตรวจซ้ำ ' + n + ' รายการ');
  };

  // admin ยกเลิกใบตรวจ (เช่น เปิดผิดห้อง)
  H.cancelInspection = function (db, ctx, p, out) {
    needRole(ctx, ['admin']);
    var insp = mustInsp(db, p.inspectionId);
    var room = mustRoom(db, insp.roomId);
    if (!isActive(insp)) throw err('CLOSED', 'ใบตรวจนี้ปิดไปแล้ว');
    insp.status = 'cancelled';
    insp.finishedAt = stamp(ctx.nowMs);
    insp.note = String(p.reason || 'ยกเลิกโดย ' + ctx.user.name).slice(0, 200);
    put(out, 'Inspections', insp);
    setRoom(out, ctx, room, { status: insp.type === 'checkout' ? 'dirty' : 'ready', inspectionId: '' });
    log(out, ctx, 'cancel', room.id, insp.id, insp.note);
  };

  function apply(db, ctx, action, payload) {
    var out = { ok: true, ops: [], notify: [], result: null };
    try {
      if (!H.hasOwnProperty(action)) throw err('UNKNOWN', 'ไม่รู้จักคำสั่ง ' + action);
      if (!ctx || !ctx.user || !ctx.user.role) throw err('AUTH', 'ไม่พบผู้ใช้');
      H[action](db, ctx, payload || {}, out);
      return out;
    } catch (e) {
      if (e instanceof CoreError) return { ok: false, code: e.code, message: e.message, ops: [], notify: [] };
      throw e;
    }
  }

  // ---------- ตัวเลือกข้อมูลสำหรับหน้าจอ ----------
  var KIND_ORDER = { fix: 0, check: 1, clean: 2 };

  // งานของฉัน: ห้องที่ถึงคิวของบทบาทนี้
  function tasksFor(db, user) {
    var t = [], role = user.role;
    if (role === 'maid') {
      db.rooms.forEach(function (r) {
        if (r.status === 'dirty') t.push({ kind: 'clean', roomId: sid(r.id), floor: Number(r.floor), since: r.updatedAt, inspectionId: '', step: 0 });
      });
    }
    db.inspections.forEach(function (i) {
      if (!isActive(i)) return;
      var room = roomOf(db, i.roomId);
      var base = {
        roomId: sid(i.roomId), floor: room ? Number(room.floor) : 0, inspectionId: i.id, since: i.stepSince,
        step: Number(i.step), type: i.type, round: i.round, recheck: recheckList(i).length
      };
      if (i.status === 'fixing' && role === 'maid') {
        base.kind = 'fix'; base.step = Number(i.failedStep); t.push(base);
      } else if (i.status === 'open' && STEP_ROLE[i.step] === role) {
        base.kind = 'check'; t.push(base);
      }
    });
    t.sort(function (a, b) {
      return (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (toMs(a.since) - toMs(b.since)) || (a.roomId < b.roomId ? -1 : 1);
    });
    return t;
  }

  function summary(db, nowMs, overdueMin) {
    overdueMin = overdueMin || 30;
    var counts = { ready: 0, occupied: 0, dirty: 0, inspecting: 0, issue: 0 };
    db.rooms.forEach(function (r) { if (counts[r.status] != null) counts[r.status]++; });
    var today = dateOf(nowMs);
    var groups = {
      checkout: { total: 0, passed: 0, open: 0, fixing: 0 },
      morning: { total: 0, passed: 0, open: 0, fixing: 0 },
      afternoon: { total: 0, passed: 0, open: 0, fixing: 0 }
    };
    var overdue = [];
    db.inspections.forEach(function (i) {
      if (i.status === 'cancelled') return;
      if (i.date === today) {
        var g = groups[i.type === 'checkout' ? 'checkout' : i.round];
        if (g) {
          g.total++;
          if (i.status === 'passed') g.passed++; else if (i.status === 'open') g.open++; else if (i.status === 'fixing') g.fixing++;
        }
      }
      if (isActive(i)) {
        var m = minutesSince(i.stepSince, nowMs);
        if (m >= overdueMin) {
          overdue.push({
            roomId: sid(i.roomId), inspectionId: i.id, status: i.status, step: Number(i.step), minutes: m,
            waitingFor: i.status === 'fixing' ? 'maid' : STEP_ROLE[i.step]
          });
        }
      }
    });
    db.rooms.forEach(function (r) {
      if (r.status === 'dirty') {
        var m = minutesSince(r.updatedAt, nowMs);
        if (m >= overdueMin) overdue.push({ roomId: sid(r.id), inspectionId: '', status: 'dirty', step: 0, minutes: m, waitingFor: 'maid' });
      }
    });
    overdue.sort(function (a, b) { return b.minutes - a.minutes; });
    var openIssues = db.issues.filter(function (x) { return x.status === 'open'; });
    return { counts: counts, groups: groups, overdue: overdue, openIssues: openIssues, topItems: topItems(db.issues) };
  }

  function topItems(issues) {
    var by = {};
    issues.forEach(function (x) {
      var k = x.itemNo;
      if (!by[k]) by[k] = { itemNo: k, name: x.itemName, count: 0, missing: 0, damaged: 0, rooms: {} };
      by[k].count++;
      by[k][x.kind === 'damaged' ? 'damaged' : 'missing']++;
      by[k].rooms[x.roomId] = 1;
    });
    return Object.keys(by).map(function (k) {
      var o = by[k]; o.roomCount = Object.keys(o.rooms).length; delete o.rooms; return o;
    }).sort(function (a, b) { return b.count - a.count; }).slice(0, 8);
  }

  // ---------- ข้อมูลตั้งต้น ----------
  function seedItems() { return DEFAULT_ITEMS.map(function (x, i) { return { no: i + 1, name: x[0], qty: x[1] }; }); }
  function seedRooms(floors, perFloor) {
    var rooms = [];
    for (var f = 1; f <= (floors || 5); f++) {
      for (var n = 1; n <= (perFloor || 8); n++) {
        rooms.push({ id: String(f * 100 + n), floor: f, status: 'ready', inspectionId: '', updatedAt: '' });
      }
    }
    return rooms;
  }
  function seedUsers() {
    return [
      { id: 'admin', name: 'ผู้ดูแลระบบ', role: 'admin', floors: '', active: 1 },
      { id: 'maid01', name: 'แม่บ้าน ชั้น 1', role: 'maid', floors: '1', active: 1 },
      { id: 'maid02', name: 'แม่บ้าน ชั้น 2', role: 'maid', floors: '2', active: 1 },
      { id: 'maid03', name: 'แม่บ้าน ชั้น 3', role: 'maid', floors: '3', active: 1 },
      { id: 'maid04', name: 'แม่บ้าน ชั้น 4', role: 'maid', floors: '4', active: 1 },
      { id: 'maid05', name: 'แม่บ้าน ชั้น 5', role: 'maid', floors: '5', active: 1 },
      { id: 'head', name: 'หัวหน้าแม่บ้าน', role: 'head_maid', floors: '', active: 1 },
      { id: 'front', name: 'หัวหน้าฝ่ายต้อนรับ', role: 'reception', floors: '', active: 1 }
    ];
  }
  function seedDb() {
    return { rooms: seedRooms(5, 8), items: seedItems(), users: seedUsers(), inspections: [], steps: [], issues: [] };
  }

  return {
    ROLES: ROLES, STEP_ROLE: STEP_ROLE, STEP_LABEL: STEP_LABEL, ROOM_STATUS: ROOM_STATUS, ROUNDS: ROUNDS,
    KIND_LABEL: KIND_LABEL, SCHEMA: SCHEMA,
    apply: apply, tasksFor: tasksFor, summary: summary, topItems: topItems,
    stamp: stamp, dateOf: dateOf, toMs: toMs, minutesSince: minutesSince, recheckList: recheckList,
    roomOf: roomOf, inspOf: inspOf, activeInspOf: activeInspOf,
    seedItems: seedItems, seedRooms: seedRooms, seedUsers: seedUsers, seedDb: seedDb
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = Core; }
