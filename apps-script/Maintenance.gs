// Maintenance.gs — เก็บข้อมูลเก่าเข้าคลัง (รายเดือน) และซ่อมข้อมูลที่ไม่สอดคล้อง
// เรียกจากเมนู "ระบบตรวจห้อง" ในชีต — ห้ามลบแถวในชีตด้วยมือ ให้ใช้เมนูนี้แทน
//
// หลักการ: ย้าย (คัดลอกไปไฟล์คลังก่อน แล้วค่อยลบจากชีตหลัก) เฉพาะข้อมูลที่ "ปิดงานแล้ว"
//   - ไม่แตะ Rooms / Items / Users
//   - ไม่แตะใบตรวจที่ยังค้าง (open / fixing) และไม่แตะปัญหาที่ยังไม่แก้ (open)
//   - ล็อกชีตระหว่างทำงาน (แอปจะรอ/ลองใหม่) และล้างแคชเมื่อเสร็จ ให้แอปเห็นข้อมูลล่าสุดทันที

var ARCHIVE_SHEETS = ['Inspections', 'Steps', 'Issues', 'Log'];
var MIN_KEEP_DAYS = 14;              // เก็บในชีตหลักอย่างน้อยกี่วัน (หน้าประวัติของแอดมินดูย้อนหลังได้เท่าที่ยังอยู่ในชีต)
var REPAIR_ROOM_STATUS = 'dirty';    // ห้องที่สถานะค้างแต่ไม่มีใบตรวจ ให้กลับไปสถานะนี้ (dirty = ทำความสะอาดแล้วตรวจใหม่ / ready = พร้อมขายเลย)
var CHUNK_ROWS = 1000;

function isBlank_(row) {
  for (var i = 0; i < row.length; i++) if (row[i] !== '') return false;
  return true;
}

// ---------- ไฟล์คลัง (สเปรดชีตใหม่ใน Drive ของผู้รัน สร้างเมื่อมีข้อมูลต้องย้ายจริงเท่านั้น) ----------
function newArchive_(label) {
  var a = SpreadsheetApp.create('ตรวจห้อง - คลังข้อมูล ' + label);
  ARCHIVE_SHEETS.forEach(function (name, i) {
    var def = Core.SCHEMA[name];
    var sh = i === 0 ? a.getSheets()[0].setName(name) : a.insertSheet(name);
    sh.getRange(1, 1, sh.getMaxRows(), def.cols.length).setNumberFormat('@'); // ข้อความล้วน กันชีตแปลงวันที่/เลขห้อง
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  return a;
}

function appendArchive_(ctx, name, rows) {
  if (!ctx.ss) ctx.ss = newArchive_(ctx.label);
  var def = Core.SCHEMA[name], n = def.cols.length;
  var sh = ctx.ss.getSheetByName(name);
  var start = Math.max(sh.getLastRow(), 1) + 1;
  var need = start + rows.length - 1, max = sh.getMaxRows();
  if (need > max) {
    sh.insertRowsAfter(max, need - max);
    sh.getRange(max + 1, 1, need - max, n).setNumberFormat('@');
  }
  sh.getRange(start, 1, rows.length, n).setValues(rows);
}

// ย้ายแถวที่ shouldMove(แถวเป็น object) เป็นจริง ไปไฟล์คลัง แล้วลบออกจากชีตหลัก → คืนจำนวนที่ย้าย
// ลำดับที่ปลอดภัย: คัดลอกไปคลังก่อน → เขียนแถวที่เก็บไว้ทับด้านบน → ล้างแถวท้ายที่เหลือ
// (ถ้าสคริปต์หยุดกลางคัน อย่างแย่สุดคือมีแถวซ้ำ ไม่มีข้อมูลหาย)
function moveRows_(name, shouldMove, ctx) {
  var def = Core.SCHEMA[name], n = def.cols.length;
  var sh = ss_().getSheetByName(name);
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var keep = [], moved = 0;
  for (var s = 2; s <= last; s += CHUNK_ROWS) {
    var cnt = Math.min(CHUNK_ROWS, last - s + 1);
    var vals = sh.getRange(s, 1, cnt, n).getValues();
    var mv = [];
    for (var r = 0; r < vals.length; r++) {
      var row = vals[r];
      if (isBlank_(row)) continue;
      var o = {};
      for (var j = 0; j < n; j++) o[def.cols[j]] = cell_(row[j], def.cols[j], def);
      (shouldMove(o) ? mv : keep).push(row);
    }
    if (mv.length) { appendArchive_(ctx, name, mv); moved += mv.length; }
  }
  if (moved) {
    if (keep.length) sh.getRange(2, 1, keep.length, n).setValues(keep);
    var from = keep.length + 2;
    if (last >= from) sh.getRange(from, 1, last - from + 1, n).clearContent();
  }
  return moved;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    SpreadsheetApp.getUi().alert('ระบบกำลังถูกใช้งานอยู่ ลองใหม่อีกครั้งในอีกสักครู่');
    return;
  }
  try { fn(); } finally { lock.releaseLock(); }
}

// ---------- 1) เก็บข้อมูลเก่าเข้าคลัง ----------
function archiveOldData() {
  var ui = SpreadsheetApp.getUi();
  var ans = ui.prompt('เก็บข้อมูลเก่าเข้าคลัง',
    'เก็บข้อมูลย้อนหลังไว้ในชีตกี่วัน? (แนะนำ 31, ขั้นต่ำ ' + MIN_KEEP_DAYS + ')\nข้อมูลที่เก่ากว่านี้และปิดงานแล้วจะถูกย้ายไปไฟล์คลังใหม่ใน Google Drive', ui.ButtonSet.OK_CANCEL);
  if (ans.getSelectedButton() !== ui.Button.OK) return;
  var days = Math.floor(Number(String(ans.getResponseText()).trim()));
  if (!(days >= MIN_KEEP_DAYS)) { ui.alert('กรุณาใส่ตัวเลข ' + MIN_KEEP_DAYS + ' ขึ้นไป'); return; }

  withLock_(function () {
    var cutoff = Core.dateOf(Date.now() - days * 86400000);
    var insp = readTable_('Inspections');
    var issues = readTable_('Issues');
    var hasOpen = {};
    issues.forEach(function (x) { if (x.status === 'open') hasOpen[x.inspectionId] = 1; });
    var ids = {}, n = 0;
    insp.forEach(function (i) {
      if ((i.status === 'passed' || i.status === 'cancelled') && i.date && i.date < cutoff && !hasOpen[i.id]) { ids[i.id] = 1; n++; }
    });
    var yes = ui.alert('ยืนยันเก็บเข้าคลัง',
      'จะย้ายใบตรวจที่ปิดแล้วและลงวันที่ก่อน ' + cutoff + ' จำนวน ' + n + ' ใบ (พร้อมผลตรวจ ลายเซ็น และปัญหาของใบเหล่านั้น) และ Log ที่เก่ากว่าวันดังกล่าว\n' +
      'ไปไฟล์คลังใหม่ใน Drive แล้วลบออกจากชีตนี้\n\nใบตรวจที่ยังค้าง ปัญหาที่ยังไม่แก้ และสถานะห้องจะไม่ถูกแตะ', ui.ButtonSet.YES_NO);
    if (yes !== ui.Button.YES) return;

    var ctx = { ss: null, label: cutoff + ' (สร้าง ' + Core.stamp(Date.now()) + ')' };
    var res = {
      Inspections: moveRows_('Inspections', function (o) { return !!ids[o.id]; }, ctx),
      Steps: moveRows_('Steps', function (o) { return !!ids[o.inspectionId]; }, ctx),
      Issues: moveRows_('Issues', function (o) { return !!ids[o.inspectionId]; }, ctx),
      Log: moveRows_('Log', function (o) { return String(o.at).slice(0, 10) < cutoff; }, ctx)
    };
    bumpVersion_();
    var total = res.Inspections + res.Steps + res.Issues + res.Log;
    ui.alert(total ? 'เก็บเข้าคลังเรียบร้อย' : 'ไม่มีข้อมูลที่ต้องย้าย',
      total ? 'ใบตรวจ ' + res.Inspections + ' · ผลตรวจ ' + res.Steps + ' · ปัญหา ' + res.Issues + ' · Log ' + res.Log + ' แถว\n\nไฟล์คลัง:\n' + ctx.ss.getUrl()
            : 'ไม่มีใบตรวจที่ปิดแล้วและเก่ากว่า ' + cutoff);
  });
}

// ---------- 2) ตรวจและซ่อมข้อมูลที่ไม่สอดคล้อง (เช่น หลังลบแถวในชีตด้วยมือ) ----------
// ปัญหาที่พบบ่อย: ลบ Inspections แต่ห้องยังเป็น "กำลังตรวจ/มีปัญหา", ปัญหา (Issues) ที่ยังเปิดอยู่แต่ใบตรวจหายไป → แอปขึ้นแดงและกดแก้ไม่ได้
function repairData() {
  var ui = SpreadsheetApp.getUi();
  withLock_(function () {
    var rooms = readTable_('Rooms'), insp = readTable_('Inspections'), issues = readTable_('Issues');
    var byId = {};
    insp.forEach(function (i) { byId[i.id] = i; });

    var badRooms = rooms.filter(function (r) {
      if (r.status !== 'inspecting' && r.status !== 'issue') return false;
      var i = byId[r.inspectionId];
      return !i || (i.status !== 'open' && i.status !== 'fixing');
    });
    var orphanIssues = issues.filter(function (x) { return !byId[x.inspectionId]; });
    var stepSh = ss_().getSheetByName('Steps'), stepLast = stepSh.getLastRow(), orphanSteps = 0;
    if (stepLast >= 2) {
      stepSh.getRange(2, 1, stepLast - 1, 1).getValues().forEach(function (v) { if (v[0] !== '' && !byId[String(v[0]).trim()]) orphanSteps++; });
    }

    if (!badRooms.length && !orphanIssues.length && !orphanSteps) {
      bumpVersion_(); // แก้ชีตด้วยมือไม่ล้างแคชของแอป — กดเมนูนี้เพื่อให้แอปอ่านข้อมูลล่าสุดทันที
      ui.alert('ข้อมูลสอดคล้องกันดี', 'ไม่พบห้องที่สถานะค้าง และไม่พบผลตรวจ/ปัญหาที่ใบตรวจหายไป\n(ล้างแคชของแอปให้แล้ว แอปจะอ่านข้อมูลล่าสุดจากชีต)', ui.ButtonSet.OK);
      return;
    }
    var list = badRooms.map(function (r) { return r.id; });
    var msg = 'พบรายการที่ไม่สอดคล้อง:\n' +
      '• ห้องที่สถานะค้าง (กำลังตรวจ/มีปัญหา) แต่ไม่มีใบตรวจที่ใช้งานอยู่: ' + badRooms.length +
      (badRooms.length ? ' ห้อง (' + list.slice(0, 15).join(', ') + (list.length > 15 ? ' ...' : '') + ')' : '') + '\n' +
      '• ปัญหา (Issues) ที่ใบตรวจหายไป: ' + orphanIssues.length + ' แถว\n' +
      '• ผลตรวจ (Steps) ที่ใบตรวจหายไป: ' + orphanSteps + ' แถว\n\n' +
      'ซ่อมโดย: ตั้งห้องที่ค้างกลับเป็นสถานะ "' + REPAIR_ROOM_STATUS + '" และย้ายแถวที่ใบตรวจหายไปเก็บในไฟล์คลัง\nดำเนินการเลยไหม?';
    if (ui.alert('ตรวจและซ่อมข้อมูล', msg, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

    var def = Core.SCHEMA.Rooms, roomSh = ss_().getSheetByName('Rooms'), now = Core.stamp(Date.now());
    badRooms.forEach(function (r) {
      r.status = REPAIR_ROOM_STATUS; r.inspectionId = ''; r.updatedAt = now;
      roomSh.getRange(r._row, 1, 1, def.cols.length).setValues([toArr_(r, def)]);
    });
    var ctx = { ss: null, label: 'ซ่อมข้อมูล ' + now };
    var a = moveRows_('Issues', function (o) { return !byId[o.inspectionId]; }, ctx);
    var b = moveRows_('Steps', function (o) { return !byId[o.inspectionId]; }, ctx);
    bumpVersion_();
    ui.alert('ซ่อมเรียบร้อย', 'ปรับสถานะห้อง ' + badRooms.length + ' ห้อง · ย้ายปัญหา ' + a + ' แถว · ย้ายผลตรวจ ' + b + ' แถว' + (ctx.ss ? '\n\nไฟล์คลัง:\n' + ctx.ss.getUrl() : ''));
  });
}
