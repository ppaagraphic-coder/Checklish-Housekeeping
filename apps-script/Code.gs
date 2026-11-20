/**
 * ระบบตรวจเช็กห้องพัก — Backend (Google Apps Script)
 *
 * ผูกกับ Google Sheet (Extensions > Apps Script) ทำหน้าที่เป็น API ให้หน้าเว็บบน GitHub Pages
 * ไฟล์คู่กัน: Core.gs (ตรรกะ workflow — คัดลอกมาจาก docs/core.js ด้วย tools/sync-core.js)
 *
 * วิธีติดตั้งดูใน README.md
 */

var TZ = 'Asia/Bangkok';
var TOKEN_HOURS = 12;
var MAX_FAILS = 5;                 // ใส่ PIN ผิดกี่ครั้งถึงล็อก
var LOCK_SECONDS = 300;            // ล็อกกี่วินาที
var TAIL = { Inspections: 400, Steps: 1000, Issues: 1000 }; // อ่านเฉพาะแถวท้าย ๆ ให้เร็วเมื่อข้อมูลสะสมหลายปี
var USER_CACHE_SECONDS = 60;      // จำรายชื่อผู้ใช้ไว้กี่วินาที (แก้ชีต Users แล้วมีผลภายในเวลานี้)
// แต่ละคำสั่งอ่านเฉพาะชีตที่ต้องใช้ — เร็วกว่าอ่านทุกชีตทุกครั้งมาก
var NEED = {
  checkin: ['Rooms', 'Inspections'], checkout: ['Rooms'], cleaned: ['Rooms', 'Inspections'],
  startRoutine: ['Rooms', 'Inspections'], startRoutineMany: ['Rooms', 'Inspections'],
  submitStep: ['Rooms', 'Items', 'Inspections', 'Issues'], bulkPass: ['Rooms', 'Items', 'Inspections', 'Issues'],
  markFixed: ['Rooms', 'Inspections', 'Issues'], cancelInspection: ['Rooms', 'Inspections']
};

var MAX_BATCH = 30;                // จำนวนคำสั่งสูงสุดต่อ 1 คำขอแบบ batch

// ---------------------------------------------------------------------------
// จุดเข้า API
// ---------------------------------------------------------------------------

function doGet() {
  return json_({ ok: true, name: 'room-check API' });
}

function doPost(e) {
  var res;
  try {
    var req = JSON.parse(e.postData.contents);
    res = route_(req);
  } catch (err) {
    res = { ok: false, code: 'ERROR', message: 'ระบบขัดข้อง: ' + err.message };
  }
  return json_(res);
}

function json_(obj) {
  // ไม่ส่งเลขแถวภายในออกไปที่หน้าเว็บ
  var text = JSON.stringify(obj, function (k, v) { return k === '_row' ? undefined : v; });
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function route_(req) {
  if (req.action === 'login') return login_(req);
  var user = auth_(req.token);
  if (!user) return { ok: false, code: 'AUTH', message: 'หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่' };
  if (req.action === 'ping') return { ok: true, ver: version_() };
  if (req.action === 'state') return state_(user);
  if (req.action === 'batch') return batch_(user, req);
  return act_(user, req);
}

// ---------------------------------------------------------------------------
// ตั้งค่าชีตครั้งแรก + เมนู
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('ระบบตรวจห้อง')
    .addItem('ตั้งค่าชีตครั้งแรก', 'setupSheets')
    .addItem('นำ PIN ใหม่ในคอลัมน์ newPin มาใช้', 'applyNewPins')
    .addToUi();
}

function setupSheets() {
  var ss = ss_();
  var created = [];
  Object.keys(Core.SCHEMA).forEach(function (name) {
    var def = Core.SCHEMA[name];
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); created.push(name); }
    // ตั้งเป็นข้อความล้วน กัน Google Sheet แปลงวันที่/เลขห้องเอง
    sh.getRange(1, 1, sh.getMaxRows(), def.cols.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });

  var rooms = ss.getSheetByName('Rooms');
  if (rooms.getLastRow() < 2) writeRows_('Rooms', Core.seedRooms(5, 8));
  var items = ss.getSheetByName('Items');
  if (items.getLastRow() < 2) writeRows_('Items', Core.seedItems());

  var msg = 'ตั้งค่าชีตเรียบร้อย';
  var users = ss.getSheetByName('Users');
  if (users.getLastRow() < 2) {
    if (!prop_('SECRET')) PropertiesService.getScriptProperties().setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
    var list = Core.seedUsers();
    var lines = [];
    list.forEach(function (u) {
      var pin = String(Math.floor(1000 + Math.random() * 9000));
      u.pinHash = hashPin_(u.id, pin);
      u.lineUserId = '';
      u.newPin = '';
      lines.push(u.id + '  (' + u.name + ')  PIN: ' + pin);
    });
    writeRows_('Users', list);
    msg += '\n\nบัญชีเริ่มต้น (จดไว้ แล้วเปลี่ยน PIN ผ่านคอลัมน์ newPin):\n\n' + lines.join('\n');
  }
  if (!prop_('SECRET')) PropertiesService.getScriptProperties().setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  notify_ui_(msg);
}

function applyNewPins() {
  var def = Core.SCHEMA.Users;
  var sh = ss_().getSheetByName('Users');
  var last = sh.getLastRow();
  if (last < 2) return notify_ui_('ยังไม่มีผู้ใช้');
  var rows = sh.getRange(2, 1, last - 1, def.cols.length).getValues();
  var iId = def.cols.indexOf('id'), iHash = def.cols.indexOf('pinHash'), iNew = def.cols.indexOf('newPin');
  var done = 0, bad = [];
  for (var i = 0; i < rows.length; i++) {
    var id = String(rows[i][iId]).trim().toLowerCase();
    var pin = String(rows[i][iNew]).trim();
    if (!id || !pin) continue;
    if (!/^[a-z0-9_]{2,30}$/.test(id) || !/^\d{4,6}$/.test(pin)) { bad.push(id || ('แถว ' + (i + 2))); continue; }
    sh.getRange(i + 2, iId + 1).setValue(id);
    sh.getRange(i + 2, iHash + 1).setValue(hashPin_(id, pin));
    sh.getRange(i + 2, iNew + 1).setValue('');
    done++;
  }
  CacheService.getScriptCache().remove('users');
  var msg = 'ตั้ง PIN ใหม่แล้ว ' + done + ' คน';
  if (bad.length) msg += '\nข้าม (ชื่อผู้ใช้ต้องเป็น a-z 0-9 _ และ PIN ต้องเป็นตัวเลข 4-6 หลัก): ' + bad.join(', ');
  notify_ui_(msg);
}

function notify_ui_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

// ---------------------------------------------------------------------------
// เข้าสู่ระบบ / token
// ---------------------------------------------------------------------------

function hashPin_(userId, pin) {
  var raw = prop_('SECRET') + ':' + userId + ':' + pin;
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw));
}

function sign_(msg) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(msg, prop_('SECRET')));
}

function makeToken_(userId) {
  var exp = Date.now() + TOKEN_HOURS * 3600000;
  var msg = userId + '.' + exp;
  return msg + '.' + sign_(msg);
}

function auth_(token) {
  if (!token || typeof token !== 'string') return null;
  var parts = token.split('.');
  if (parts.length !== 3) return null;
  var msg = parts[0] + '.' + parts[1];
  if (sign_(msg) !== parts[2]) return null;
  if (Number(parts[1]) < Date.now()) return null;
  return findActiveUser_(parts[0]);
}

function findUser_(id) {
  var users = readTable_('Users');
  for (var i = 0; i < users.length; i++) {
    if (users[i].id === id && users[i].active === 1) return users[i];
  }
  return null;
}

// ผู้ใช้ที่เปิดใช้งาน (ไม่รวม pinHash) แคชไว้สั้น ๆ ใช้ตอนตรวจ token
function activeUsers_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('users');
  if (hit) return JSON.parse(hit);
  var list = readTable_('Users').filter(function (u) { return u.active === 1; }).map(publicUser_);
  cache.put('users', JSON.stringify(list), USER_CACHE_SECONDS);
  return list;
}
function findActiveUser_(id) {
  var list = activeUsers_();
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function publicUser_(u) { return { id: u.id, name: u.name, role: u.role, floors: u.floors }; }

function login_(req) {
  var id = String(req.username || '').trim().toLowerCase();
  var pin = String(req.pin || '').trim();
  var bad = { ok: false, code: 'BAD_LOGIN', message: 'ชื่อผู้ใช้หรือ PIN ไม่ถูกต้อง' };
  if (!/^[a-z0-9_]{2,30}$/.test(id)) return bad;
  var cache = CacheService.getScriptCache();
  var key = 'fail_' + id;
  if (Number(cache.get(key) || 0) >= MAX_FAILS) {
    return { ok: false, code: 'LOCKED', message: 'ใส่ PIN ผิดหลายครั้ง กรุณารอ 5 นาทีแล้วลองใหม่' };
  }
  var user = findUser_(id);
  if (!user || !user.pinHash || user.pinHash !== hashPin_(id, pin)) {
    cache.put(key, String(Number(cache.get(key) || 0) + 1), LOCK_SECONDS);
    return bad;
  }
  cache.remove(key);
  var pu = publicUser_(user);
  return { ok: true, token: makeToken_(id), user: pu, expiresAt: Date.now() + TOKEN_HOURS * 3600000, state: state_(pu) };
}

// ---------------------------------------------------------------------------
// อ่าน/เขียน Google Sheet
// ---------------------------------------------------------------------------

var SS_ = null;
function ss_() { return SS_ || (SS_ = SpreadsheetApp.getActiveSpreadsheet()); }
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }

function cell_(v, col, def) {
  if (v instanceof Date) {
    v = Utilities.formatDate(v, TZ, col === 'date' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss');
  }
  if (def.num && def.num.indexOf(col) >= 0) return v === '' || v == null ? 0 : Number(v);
  return v == null ? '' : String(v).trim();
}

function readTable_(name, tail) {
  var def = Core.SCHEMA[name];
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('ไม่พบชีต ' + name + ' — เปิดเมนู "ระบบตรวจห้อง > ตั้งค่าชีตครั้งแรก" ก่อน');
  var last = sh.getLastRow();
  if (last < 2) return [];
  var start = tail ? Math.max(2, last - tail + 1) : 2;
  var vals = sh.getRange(start, 1, last - start + 1, def.cols.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var empty = true;
    for (var k = 0; k < row.length; k++) if (row[k] !== '') { empty = false; break; }
    if (empty) continue;
    var o = { _row: start + i };
    for (var j = 0; j < def.cols.length; j++) o[def.cols[j]] = cell_(row[j], def.cols[j], def);
    out.push(o);
  }
  return out;
}

function toArr_(o, def) {
  return def.cols.map(function (c) { var v = o[c]; return v == null ? '' : v; });
}

// เขียน rows ที่ยังไม่มีแถว (ต่อท้าย) — ใช้ตอนตั้งค่าและตอน flush
// รูปแบบ "ข้อความล้วน" ตั้งไว้ทั้งคอลัมน์แล้วตอน setupSheets จึงไม่ต้องตั้งซ้ำทุกครั้งที่เขียน (ลดเวลา)
// ถ้าแถวเต็มชีต เพิ่มแถวให้ก่อน (ครั้งละ 500) แล้วตั้งรูปแบบเฉพาะแถวที่เพิ่ม
function writeRows_(name, objs) {
  if (!objs.length) return;
  var def = Core.SCHEMA[name];
  var sh = ss_().getSheetByName(name);
  var start = sh.getLastRow() + 1;
  var need = start + objs.length - 1;
  var max = sh.getMaxRows();
  if (need > max) {
    sh.insertRowsAfter(max, need - max + 500);
    sh.getRange(max + 1, 1, need - max + 500, def.cols.length).setNumberFormat('@');
  }
  sh.getRange(start, 1, objs.length, def.cols.length).setValues(objs.map(function (o) { return toArr_(o, def); }));
  objs.forEach(function (o, i) { o._row = start + i; });
}

// เขียนผลของ Core.apply ลงชีต: แถวเดิมเขียนทับ แถวใหม่ต่อท้าย (รวมหลาย op ของ object เดียวกัน)
function flush_(ops) {
  var by = {};
  ops.forEach(function (op) {
    var list = by[op.table] || (by[op.table] = []);
    if (list.indexOf(op.row) < 0) list.push(op.row);
  });
  Object.keys(by).forEach(function (name) {
    var def = Core.SCHEMA[name];
    var sh = ss_().getSheetByName(name);
    var fresh = [], upd = [];
    by[name].forEach(function (o) { (o._row ? upd : fresh).push(o); });
    if (upd.length) {
      upd.sort(function (a, b) { return a._row - b._row; });
      var lo = upd[0]._row, hi = upd[upd.length - 1]._row;
      // แถวที่ติดกันรวมเป็นช่วงเดียว เขียนครั้งเดียว
      var runs = [];
      upd.forEach(function (o) {
        var last = runs[runs.length - 1];
        if (last && o._row === last.rows[last.rows.length - 1]._row + 1) last.rows.push(o);
        else runs.push({ start: o._row, rows: [o] });
      });
      if (runs.length <= 2 || hi - lo + 1 > 400) {
        runs.forEach(function (run) {
          sh.getRange(run.start, 1, run.rows.length, def.cols.length).setValues(run.rows.map(function (o) { return toArr_(o, def); }));
        });
      } else {
        // หลายช่วงกระจาย (เช่น เริ่มตรวจทั้งชั้น): อ่านช่วงเดียว แก้ในหน่วยความจำ เขียนกลับครั้งเดียว — ล็อกไม่ค้างนาน
        var rng = sh.getRange(lo, 1, hi - lo + 1, def.cols.length);
        var vals = rng.getValues();
        upd.forEach(function (o) { vals[o._row - lo] = toArr_(o, def); });
        rng.setValues(vals);
      }
    }
    writeRows_(name, fresh);
  });
}

function loadDb_(only) {
  function want(n) { return !only || only.indexOf(n) >= 0; }
  return {
    rooms: want('Rooms') ? readTable_('Rooms') : [],
    items: want('Items') ? readTable_('Items') : [],
    users: want('Users') ? readTable_('Users') : [],
    inspections: want('Inspections') ? readTable_('Inspections', TAIL.Inspections) : [],
    steps: want('Steps') ? readTable_('Steps', TAIL.Steps) : [],
    issues: want('Issues') ? readTable_('Issues', TAIL.Issues) : []
  };
}

// ---------------------------------------------------------------------------
// อ่านสถานะ / ส่งคำสั่ง
// ---------------------------------------------------------------------------

// เลขเวอร์ชันข้อมูล: เปลี่ยนทุกครั้งที่มีการเขียน หน้าเว็บถามเลขนี้ (เบามาก) แล้วดึงข้อมูลเต็มเมื่อเปลี่ยนเท่านั้น
function version_() {
  var cache = CacheService.getScriptCache();
  var v = cache.get('ver');
  if (!v) { v = Utilities.getUuid(); cache.put('ver', v, 21600); }
  return v;
}
function bumpVersion_() { var v = Utilities.getUuid(); CacheService.getScriptCache().put('ver', v, 21600); return v; }

// ข้อมูลทั้งชุด (ยังไม่กรองตามผู้ใช้) แคชไว้ตามเลขเวอร์ชัน
// หลังมีการแก้ไข เครื่องแรกที่ขอจะอ่านชีต เครื่องอื่นได้จากแคชทันที (ไม่ต้องอ่านชีต 6 แผ่นซ้ำทุกเครื่อง)
var CHUNK = 30000; // ตัวอักษรต่อชิ้น (ไทยสูงสุด 3 ไบต์/ตัว ต้องไม่เกิน 100KB ต่อค่า)

function buildFull_() {
  var now = Date.now();
  var db = loadDb_();
  var cut = Core.dateOf(now - 2 * 86400000);
  var cutIssue = Core.dateOf(now - 14 * 86400000);
  var insp = db.inspections.filter(function (i) { return i.status === 'open' || i.status === 'fixing' || i.date >= cut; });
  var ids = {};
  insp.forEach(function (i) { ids[i.id] = 1; });
  return {
    rooms: db.rooms, items: db.items,
    users: db.users.filter(function (u) { return u.active === 1; }).map(publicUser_),
    inspections: insp,
    steps: db.steps.filter(function (s) { return ids[s.inspectionId]; }),
    issues: db.issues.filter(function (x) { return ids[x.inspectionId] || String(x.reportedAt).slice(0, 10) >= cutIssue; })
  };
}

function loadFull_() {
  var cache = CacheService.getScriptCache();
  var v = version_();
  var n = Number(cache.get('st_' + v + '_n') || 0);
  if (n) {
    var keys = [];
    for (var i = 0; i < n; i++) keys.push('st_' + v + '_' + i);
    var got = cache.getAll(keys), parts = [], ok = true;
    for (var k = 0; k < n; k++) { if (got[keys[k]] == null) { ok = false; break; } parts.push(got[keys[k]]); }
    if (ok) return { full: JSON.parse(parts.join('')), ver: v };
  }
  var full = buildFull_();
  try {
    var text = JSON.stringify(full, function (kk, vv) { return kk === '_row' ? undefined : vv; });
    full = JSON.parse(text);
    var put = {}, c = 0;
    for (var p = 0; p < text.length; p += CHUNK) put['st_' + v + '_' + (c++)] = text.slice(p, p + CHUNK);
    put['st_' + v + '_n'] = String(c);
    cache.putAll(put, 21600);
  } catch (e) { /* แคชไม่ได้ก็ใช้ข้อมูลที่อ่านมาตรง ๆ */ }
  return { full: full, ver: v };
}

function state_(user) {
  var r = loadFull_(), full = r.full;
  var out = {
    rooms: full.rooms, items: full.items, users: full.users, inspections: full.inspections, steps: full.steps,
    issues: full.issues
  };
  if (user.role !== 'admin') {
    var ids = {};
    full.inspections.forEach(function (i) { ids[i.id] = 1; });
    out.issues = full.issues.filter(function (x) { return ids[x.inspectionId]; });
  }
  // แม่บ้านได้รับเฉพาะข้อมูลของชั้นตัวเอง (กรองที่ฝั่งเซิร์ฟเวอร์ ไม่ใช่แค่ซ่อนในหน้าจอ)
  return { ok: true, now: Date.now(), user: publicUser_(user), ver: r.ver, db: Core.scopeDb(out, user) };
}

function act_(user, req) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    return { ok: false, code: 'BUSY', message: 'ระบบกำลังประมวลผลคำสั่งของคนอื่น กรุณารอสักครู่' };
  }
  var res, out;
  try {
    var cache = CacheService.getScriptCache();
    // กันส่งซ้ำ: คำสั่งเดิม (opId เดิม) ที่เคยทำสำเร็จแล้ว คืนผลเดิมโดยไม่ทำซ้ำ
    if (req.opId) {
      var hit = cache.get('op_' + req.opId);
      if (hit) return JSON.parse(hit);
    }
    var db = loadDb_(NEED[req.action]);
    out = Core.apply(db, { user: publicUser_(user), nowMs: Date.now() }, req.action, req.payload);
    if (out.ok) {
      flush_(out.ops);
      var prev = version_();
      res = { ok: true, result: out.result, prev: prev, ver: bumpVersion_() };
    } else {
      res = { ok: false, code: out.code, message: out.message };
    }
    if (req.opId) cache.put('op_' + req.opId, JSON.stringify(res), 21600);
  } finally {
    lock.releaseLock();
  }
  if (out && out.ok && out.notify.length) {
    try { pushLine_(out.notify); } catch (e) { Logger.log('LINE error: ' + e.message); }
  }
  return res;
}

// หลายคำสั่งในคำขอเดียว: ล็อกครั้งเดียว อ่านชีตครั้งเดียว เขียนชีตครั้งเดียว
// req.ops = [{ opId, action, payload }] ทำตามลำดับบนข้อมูลก้อนเดียวกัน (ผลของคำสั่งก่อนหน้าเห็นได้ในคำสั่งถัดไป)
// คำสั่งที่ผิดกฎถูกข้ามเป็นรายคำสั่ง (ไม่ทำให้คำสั่งอื่นล้ม) ส่งซ้ำปลอดภัยเพราะกันซ้ำด้วย opId รายคำสั่ง
function batch_(user, req) {
  var ops = req.ops;
  if (!ops || !ops.length || ops.length > MAX_BATCH) {
    return { ok: false, code: 'ERROR', message: 'จำนวนคำสั่งในชุดไม่ถูกต้อง' };
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    return { ok: false, code: 'BUSY', message: 'ระบบกำลังประมวลผลคำสั่งของคนอื่น กรุณารอสักครู่' };
  }
  var results = [], allOps = [], notify = [], res;
  try {
    var cache = CacheService.getScriptCache();
    var keys = ops.map(function (o) { return 'op_' + o.opId; });
    var seen = cache.getAll(keys);
    var need = {}, fresh = 0;
    ops.forEach(function (o, i) {
      if (o.opId && seen[keys[i]]) return;
      fresh++;
      (NEED[o.action] || []).forEach(function (n) { need[n] = 1; });
    });
    var prev = version_();
    if (fresh) {
      var db = loadDb_(Object.keys(need));
      var ctx = { user: publicUser_(user), nowMs: Date.now() };
      var put = {};
      ops.forEach(function (o, i) {
        if (o.opId && seen[keys[i]]) {
          var c = JSON.parse(seen[keys[i]]);
          results[i] = { opId: o.opId, ok: c.ok, code: c.code, message: c.message, result: c.result };
          return;
        }
        var out = Core.apply(db, { user: ctx.user, nowMs: Date.now() }, o.action, o.payload);
        var r = out.ok
          ? { opId: o.opId, ok: true, result: out.result }
          : { opId: o.opId, ok: false, code: out.code, message: out.message };
        if (out.ok) {
          allOps = allOps.concat(out.ops);
          notify = notify.concat(out.notify);
        }
        results[i] = r;
        if (o.opId) put['op_' + o.opId] = JSON.stringify(r);
      });
      if (allOps.length) flush_(allOps);
      // จดผลรายคำสั่งหลังเขียนชีตสำเร็จเท่านั้น (ถ้าเขียนล้มกลางทาง ส่งซ้ำแล้วต้องทำใหม่ได้)
      if (Object.keys(put).length) cache.putAll(put, 21600);
    } else {
      ops.forEach(function (o, i) {
        var c = JSON.parse(seen[keys[i]]);
        results[i] = { opId: o.opId, ok: c.ok, code: c.code, message: c.message, result: c.result };
      });
    }
    res = { ok: true, results: results, prev: prev, ver: allOps.length ? bumpVersion_() : prev };
  } finally {
    lock.releaseLock();
  }
  if (notify.length) {
    try { pushLine_(notify); } catch (e) { Logger.log('LINE error: ' + e.message); }
  }
  return res;
}

// ---------------------------------------------------------------------------
// แจ้งเตือน LINE (ไม่บังคับ — ปิดอยู่ถ้ายังไม่ตั้ง LINE_TOKEN)
//   Script properties:
//     LINE_TOKEN  = Channel access token ของ LINE Official Account (Messaging API)
//     LINE_KINDS  = ชนิดที่จะส่ง คั่นด้วย , ค่าเริ่มต้น "issue"
//                   (issue, next, fixed, checkout) — ข้อความ push มีโควตาต่อเดือน จึงเริ่มแค่ issue
//   ใส่ User ID ของ LINE ในคอลัมน์ lineUserId ของชีต Users
// ---------------------------------------------------------------------------

function pushLine_(list) {
  var token = prop_('LINE_TOKEN');
  if (!token) return;
  var kinds = (prop_('LINE_KINDS') || 'issue').split(',').map(function (s) { return s.trim(); });
  var users = readTable_('Users').filter(function (u) { return u.active === 1 && u.lineUserId; });
  var perUser = {};
  list.forEach(function (n) {
    if (kinds.indexOf(n.kind) < 0) return;
    users.forEach(function (u) {
      if (u.role !== n.to.role) return;
      if (n.to.floor != null && u.floors) {
        var fl = u.floors.split(',').map(function (s) { return s.trim(); });
        if (fl.indexOf(String(n.to.floor)) < 0) return;
      }
      (perUser[u.lineUserId] = perUser[u.lineUserId] || []).push(n.text);
    });
  });
  Object.keys(perUser).forEach(function (to) {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: perUser[to].join('\n').slice(0, 4900) }] }),
      muteHttpExceptions: true
    });
  });
}
