// รัน: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../docs/core.js');
const Demo = require('../docs/demo.js');

// ลายเซ็นตัวอย่าง (ต้องมีหมึกพอ ไม่งั้นระบบไม่รับ)
const SIG = '320x120|20,80,60,30,100,90,150,25,210,95,290,40';

const T0 = Date.UTC(2026, 10, 20, 2, 0, 0); // 20 พ.ย. 2026 09:00 เวลาไทย
const min = (n) => n * 60000;

function fresh() {
  const db = Core.seedDb();
  const u = (id) => db.users.find((x) => x.id === id);
  let clock = T0;
  const run = (uid, action, payload, advance) => {
    clock += min(advance == null ? 1 : advance);
    return Core.apply(db, { user: u(uid), nowMs: clock }, action, payload);
  };
  const ok = (uid, action, payload, advance) => {
    const r = run(uid, action, payload, advance);
    assert.equal(r.ok, true, `${uid}:${action} → ${r.message}`);
    return r;
  };
  return { db, run, ok, now: () => clock };
}
const room = (db, id) => db.rooms.find((r) => r.id === id);
const active = (db, id) => Core.activeInspOf(db, id);

test('เวลา: stamp/toMs เป็นเวลาไทย และย้อนกลับได้', () => {
  assert.equal(Core.stamp(T0), '2026-11-20 09:00:00');
  assert.equal(Core.toMs('2026-11-20 09:00:00'), T0);
  assert.equal(Core.dateOf(Date.UTC(2026, 10, 20, 18, 0, 0)), '2026-11-21'); // 01:00 ไทยของวันถัดไป
});

test('ข้อมูลตั้งต้น: 40 ห้อง 25 รายการ ตรงฟอร์มกระดาษ', () => {
  const db = Core.seedDb();
  assert.equal(db.rooms.length, 40);
  assert.deepEqual([...new Set(db.rooms.map((r) => r.floor))], [1, 2, 3, 4, 5]);
  assert.equal(db.rooms.filter((r) => r.floor === 5).length, 8);
  assert.equal(db.rooms[0].id, '101'); assert.equal(db.rooms[39].id, '508');
  const maids = db.users.filter((u) => u.role === 'maid');
  assert.deepEqual(maids.map((u) => u.floors), ['1', '2', '3', '4', '5'], 'แม่บ้านชั้นละ 1 คน');
  assert.deepEqual(maids.map((u) => u.name), ['แม่บ้าน ชั้น 1', 'แม่บ้าน ชั้น 2', 'แม่บ้าน ชั้น 3', 'แม่บ้าน ชั้น 4', 'แม่บ้าน ชั้น 5']);
  assert.equal(db.items.length, 25);
  assert.equal(db.items[13].name, 'น้ำดื่ม');
  assert.equal(db.items[13].qty, 4);
  assert.equal(db.items.reduce((s, i) => s + i.qty, 0), 2 + 1 + 2 + 3 + 1 + 1 + 1 + 1 + 2 + 2 + 2 + 2 + 2 + 4 + 2 + 2 + 2 + 2 + 2 + 1 + 4 + 6 + 6 + 6 + 5);
});

test('วงจรเต็ม: เช็กอิน → เช็กเอาท์ → ทำความสะอาด → ตรวจ 3 ขั้น → พร้อมขาย', () => {
  const { db, ok } = fresh();
  ok('front', 'checkin', { roomId: '203' });
  assert.equal(room(db, '203').status, 'occupied');
  ok('front', 'checkout', { roomId: '203' });
  assert.equal(room(db, '203').status, 'dirty');
  const r = ok('maid02', 'cleaned', { roomId: '203', idSeed: 'abc123' });
  assert.equal(r.result.inspectionId, 'I-203-abc123');
  assert.equal(room(db, '203').status, 'inspecting');
  const id = active(db, '203').id;
  ok('maid02', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [] });
  assert.equal(active(db, '203').step, 2);
  ok('head', 'submitStep', { signature: SIG, inspectionId: id, step: 2, failures: [] });
  assert.equal(active(db, '203').step, 3);
  assert.equal(room(db, '203').status, 'inspecting');
  ok('front', 'submitStep', { signature: SIG, inspectionId: id, step: 3, failures: [] });
  assert.equal(room(db, '203').status, 'ready');
  assert.equal(active(db, '203'), null);
  assert.equal(Core.inspOf(db, id).status, 'passed');
  assert.deepEqual(db.steps.map((s) => [s.step, s.userId, s.okCount]), [[1, 'maid02', 25], [2, 'head', 25], [3, 'front', 25]]);
});

test('รอบการใช้ห้องใหม่: พักซ้ำแล้วสร้างใบตรวจใหม่ ใบเก่าเก็บเป็นประวัติ', () => {
  const { db, ok } = fresh();
  for (const seed of ['r1', 'r2']) {
    ok('front', 'checkin', { roomId: '101' });
    ok('front', 'checkout', { roomId: '101' });
    ok('maid01', 'cleaned', { roomId: '101', idSeed: seed });
    const id = active(db, '101').id;
    ok('maid01', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [] });
    ok('head', 'submitStep', { signature: SIG, inspectionId: id, step: 2, failures: [] });
    ok('front', 'submitStep', { signature: SIG, inspectionId: id, step: 3, failures: [] });
  }
  const mine = db.inspections.filter((i) => i.roomId === '101');
  assert.equal(mine.length, 2);
  assert.ok(mine.every((i) => i.status === 'passed'));
  assert.notEqual(mine[0].id, mine[1].id);
});

test('สิทธิ์: แต่ละขั้นตรวจได้เฉพาะบทบาทของขั้นนั้น และ admin ตรวจไม่ได้', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '102' });
  ok('front', 'checkout', { roomId: '102' });
  ok('maid01', 'cleaned', { roomId: '102' });
  const id = active(db, '102').id;
  for (const who of ['head', 'front', 'admin']) {
    const r = run(who, 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'FORBIDDEN');
  }
  assert.equal(run('maid01', 'checkin', { roomId: '105' }).code, 'FORBIDDEN');
  assert.equal(run('maid01', 'checkout', { roomId: '101' }).code, 'FORBIDDEN');
  assert.equal(run('head', 'cleaned', { roomId: '102' }).code, 'FORBIDDEN');
  assert.equal(run('front', 'cancelInspection', { inspectionId: id }).code, 'FORBIDDEN');
  ok('maid01', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [] });
  assert.equal(run('maid01', 'submitStep', { signature: SIG, inspectionId: id, step: 2, failures: [] }).code, 'FORBIDDEN');
});

test('กันส่งซ้ำ/ข้อมูลเก่า: step ไม่ตรงถูกปฏิเสธ และไม่แก้ข้อมูล', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '102' });
  ok('front', 'checkout', { roomId: '102' });
  ok('maid01', 'cleaned', { roomId: '102' });
  const id = active(db, '102').id;
  ok('maid01', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [] });
  const before = JSON.stringify(db);
  const r = run('maid01', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [] });
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(db), before);
});

test('พบปัญหา: ห้อง = มีปัญหา, สร้าง issue, ไม่ส่งต่อ, แจ้งแม่บ้านชั้นนั้น', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '208' });
  ok('front', 'checkout', { roomId: '208' });
  ok('maid02', 'cleaned', { roomId: '208' });
  const id = active(db, '208').id;
  const r = ok('maid02', 'submitStep', { signature: SIG,
    inspectionId: id, step: 1,
    failures: [{ itemNo: 14, kind: 'missing', found: 2, note: 'หาย 2 ขวด' }, { itemNo: 9, kind: 'damaged', found: 1 }]
  });
  assert.equal(room(db, '208').status, 'issue');
  assert.equal(Core.inspOf(db, id).status, 'fixing');
  assert.equal(Core.inspOf(db, id).recheckItems, '14,9');
  assert.equal(db.issues.length, 2);
  assert.equal(db.issues[0].itemName, 'น้ำดื่ม');
  assert.equal(db.steps[0].okCount, 23);
  assert.equal(db.steps[0].result, 'fail');
  assert.deepEqual(r.notify[0].to, { role: 'maid', floor: 2 });
  assert.equal(r.notify[0].kind, 'issue');
  // ระหว่างแก้ ห้ามผ่านต่อ
  assert.equal(run('head', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [] }).ok, false);
  assert.equal(run('maid02', 'submitStep', { signature: SIG, inspectionId: id, failures: [] }).code, 'NEEDS_FIX');
});

test('แก้แล้วตรวจซ้ำ: กลับขั้นเดิม เห็นเฉพาะรายการที่มีปัญหา แล้วผ่านต่อได้', () => {
  const { db, ok } = fresh();
  ok('front', 'checkin', { roomId: '304' });
  ok('front', 'checkout', { roomId: '304' });
  ok('maid03', 'cleaned', { roomId: '304' });
  const id = active(db, '304').id;
  ok('maid03', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [] });
  ok('head', 'submitStep', { signature: SIG, inspectionId: id, step: 2, failures: [{ itemNo: 7, kind: 'missing', found: 0 }] });
  assert.equal(room(db, '304').status, 'issue');
  // งานของแม่บ้านต้องมี "แก้ไข" และของหัวหน้าต้องยังไม่มี
  assert.equal(Core.tasksFor(db, db.users.find((u) => u.id === 'maid03')).filter((t) => t.kind === 'fix').length, 1);
  assert.equal(Core.tasksFor(db, db.users.find((u) => u.id === 'head')).length, 0);
  const fx = ok('maid03', 'markFixed', { inspectionId: id });
  assert.equal(fx.notify[0].to.role, 'head_maid');
  assert.equal(db.issues[0].status, 'fixed');
  const insp = Core.inspOf(db, id);
  assert.equal(insp.status, 'open');
  assert.equal(insp.step, 2);
  assert.deepEqual(Core.recheckList(insp), [7]);
  const t = Core.tasksFor(db, db.users.find((u) => u.id === 'head'));
  assert.equal(t.length, 1);
  assert.equal(t[0].recheck, 1);
  ok('head', 'submitStep', { signature: SIG, inspectionId: id, step: 2, failures: [] });
  assert.equal(db.steps[db.steps.length - 1].mode, 'recheck');
  assert.equal(Core.inspOf(db, id).recheckItems, '');
  ok('front', 'submitStep', { signature: SIG, inspectionId: id, step: 3, failures: [] });
  assert.equal(room(db, '304').status, 'ready');
});

test('ตรวจซ้ำแล้วยังไม่ผ่าน: วนกลับไปแก้อีกรอบ', () => {
  const { db, ok } = fresh();
  ok('front', 'checkin', { roomId: '101' });
  ok('front', 'checkout', { roomId: '101' });
  ok('maid01', 'cleaned', { roomId: '101' });
  const id = active(db, '101').id;
  ok('maid01', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [{ itemNo: 8, kind: 'damaged', found: 0 }] });
  ok('maid01', 'markFixed', { inspectionId: id });
  ok('maid01', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [{ itemNo: 8, kind: 'damaged', found: 0 }] });
  assert.equal(room(db, '101').status, 'issue');
  assert.equal(db.issues.length, 2);
  assert.equal(new Set(db.issues.map((x) => x.id)).size, 2);
});

test('เช็กอินห้องที่ยังตรวจไม่ครบ: ต้องยืนยัน, ยืนยันแล้วยกเลิกใบตรวจค้าง', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '106' });
  ok('front', 'checkout', { roomId: '106' });
  assert.equal(run('front', 'checkin', { roomId: '106' }).code, 'NEEDS_CONFIRM'); // dirty
  ok('maid01', 'cleaned', { roomId: '106' });
  const r = run('front', 'checkin', { roomId: '106' });
  assert.equal(r.code, 'NEEDS_CONFIRM');
  assert.match(r.message, /ยังตรวจไม่ครบ/);
  assert.equal(room(db, '106').status, 'inspecting');
  ok('front', 'checkin', { roomId: '106', force: true });
  assert.equal(room(db, '106').status, 'occupied');
  assert.equal(db.inspections.find((i) => i.roomId === '106').status, 'cancelled');
  assert.equal(run('front', 'checkin', { roomId: '106' }).code, 'ALREADY_OCCUPIED');
});

test('เช็กเอาท์ได้เฉพาะห้องที่มีแขก / ทำความสะอาดได้เฉพาะห้องที่รอทำความสะอาด', () => {
  const { ok, run } = fresh();
  assert.equal(run('front', 'checkout', { roomId: '101' }).code, 'NOT_OCCUPIED');
  assert.equal(run('maid01', 'cleaned', { roomId: '101' }).code, 'NOT_DIRTY');
  assert.equal(run('front', 'checkin', { roomId: '999' }).code, 'NO_ROOM');
  const r = ok('front', 'checkin', { roomId: '101' });
  assert.deepEqual(r.notify, []);
  const o = ok('front', 'checkout', { roomId: '101' });
  assert.deepEqual(o.notify[0].to, { role: 'maid', floor: 1 });
});

test('ตรวจตามรอบ: เริ่มได้เฉพาะห้องว่าง, ห้ามซ้ำรอบเดียวกันในวัน, หลายห้องพร้อมกัน', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '102' });
  const r = ok('head', 'startRoutineMany', { round: 'morning', roomIds: ['101', '102', '103'] });
  assert.equal(r.result.started.length, 2);
  assert.equal(r.result.skipped[0].roomId, '102');
  assert.equal(room(db, '101').status, 'inspecting');
  assert.equal(room(db, '102').status, 'occupied');
  assert.equal(run('head', 'startRoutine', { roomId: '101', round: 'morning' }).code, 'NOT_READY');
  // ผ่านครบแล้วเริ่มรอบเดิมอีกไม่ได้ แต่รอบบ่ายได้
  const id = active(db, '101').id;
  ok('maid01', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [] });
  ok('head', 'submitStep', { signature: SIG, inspectionId: id, step: 2, failures: [] });
  ok('front', 'submitStep', { signature: SIG, inspectionId: id, step: 3, failures: [] });
  assert.equal(run('head', 'startRoutine', { roomId: '101', round: 'morning' }).code, 'ALREADY_DONE');
  ok('head', 'startRoutine', { roomId: '101', round: 'afternoon' });
  assert.equal(run('head', 'startRoutine', { roomId: '104', round: 'night' }).code, 'BAD_ROUND');
  assert.equal(run('front', 'startRoutine', { roomId: '104', round: 'morning' }).code, 'FORBIDDEN');
});

test('ผ่านทั้งหมดที่เลือก (bulkPass): ผ่านเฉพาะที่ถึงคิวและมีสิทธิ์', () => {
  const { db, ok, run } = fresh();
  ok('head', 'startRoutineMany', { round: 'morning', roomIds: ['101', '102', '103'] });
  const ids = ['101', '102', '103'].map((r) => active(db, r).id);
  for (const id of ids.slice(0, 2)) ok('maid01', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [] });
  // 103 ยังอยู่ขั้น 1 → ถูกข้าม
  const items = ids.map((id) => ({ inspectionId: id, step: 2 }));
  const r = ok('head', 'bulkPass', { signature: SIG, items });
  assert.equal(r.result.passed.length, 2);
  assert.equal(r.result.skipped.length, 1);
  assert.equal(run('maid01', 'bulkPass', { signature: SIG, items: [{ inspectionId: ids[0], step: 3 }] }).result.passed.length, 0);
  assert.equal(Core.inspOf(db, ids[0]).step, 3);
});

test('admin ยกเลิกใบตรวจ: หลังแขกออก → รอทำความสะอาดใหม่, ตามรอบ → พร้อมขาย', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '101' });
  ok('front', 'checkout', { roomId: '101' });
  ok('maid01', 'cleaned', { roomId: '101' });
  ok('admin', 'cancelInspection', { inspectionId: active(db, '101').id, reason: 'กดผิดห้อง' });
  assert.equal(room(db, '101').status, 'dirty');
  ok('head', 'startRoutine', { roomId: '102', round: 'morning' });
  ok('admin', 'cancelInspection', { inspectionId: active(db, '102').id });
  assert.equal(room(db, '102').status, 'ready');
  assert.equal(run('admin', 'cancelInspection', { inspectionId: db.inspections[0].id }).code, 'CLOSED');
});

test('ตรวจข้อมูลรายการที่ ✗: รายการไม่มีจริงถูกปฏิเสธ, found ไม่เกินจำนวนมาตรฐาน-1', () => {
  const { db, ok, run } = fresh();
  ok('head', 'startRoutine', { roomId: '101', round: 'morning' });
  const id = active(db, '101').id;
  assert.equal(run('maid01', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [{ itemNo: 99 }] }).code, 'BAD_ITEM');
  assert.equal(db.steps.length, 0);
  ok('maid01', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [{ itemNo: 14, found: 99 }, { itemNo: 14, found: 0 }] });
  assert.equal(db.issues.length, 1);
  assert.equal(db.issues[0].found, 3);
});

test('summary: นับสถานะ รอบ ห้องค้าง รายการเกิดซ้ำ', () => {
  const db = Demo.make(T0);
  const s = Core.summary(db, T0, 30);
  assert.equal(Object.values(s.counts).reduce((a, b) => a + b, 0), 40);
  assert.equal(s.counts.occupied, 17);
  assert.ok(s.counts.dirty >= 3);
  assert.ok(s.overdue.some((o) => o.roomId === '103' && o.waitingFor === 'reception'));
  assert.ok(s.overdue.some((o) => o.roomId === '205' && o.status === 'dirty'));
  assert.ok(!s.overdue.some((o) => o.roomId === '402')); // เพิ่งเช็กเอาท์ 8 นาที
  assert.equal(s.openIssues.length, 2);
  assert.equal(s.topItems.length, 2);
});

test('โหมดทดลอง: สร้างได้ ทุกบทบาทมีงานให้ทำ', () => {
  const db = Demo.make(T0);
  const t = (id) => Core.tasksFor(db, db.users.find((u) => u.id === id));
  assert.ok(t('maid02').some((x) => x.kind === 'clean' && x.floor === 2));
  assert.ok(t('maid02').some((x) => x.kind === 'fix' && x.roomId === '208'));
  assert.ok(t('maid02').some((x) => x.kind === 'check' && x.roomId === '207'));
  assert.deepEqual(t('head').map((x) => x.roomId).sort(), ['106', '306']);
  assert.deepEqual(t('front').map((x) => x.roomId), ['103']);
  assert.deepEqual(t('admin'), []);
});

test('apply กับคำสั่งแปลก ๆ ไม่พัง', () => {
  const { db } = fresh();
  const ctx = { user: db.users[0], nowMs: T0 };
  assert.equal(Core.apply(db, ctx, 'constructor', {}).code, 'UNKNOWN');
  assert.equal(Core.apply(db, ctx, 'nope', {}).code, 'UNKNOWN');
  assert.equal(Core.apply(db, { nowMs: T0 }, 'checkin', {}).code, 'AUTH');
});

test('แม่บ้านทำได้เฉพาะชั้นของตัวเอง', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '203' });
  ok('front', 'checkout', { roomId: '203' });
  assert.equal(run('maid01', 'cleaned', { roomId: '203' }).code, 'FORBIDDEN');
  assert.equal(room(db, '203').status, 'dirty');
  ok('maid02', 'cleaned', { roomId: '203' });
  const id = active(db, '203').id;
  assert.equal(run('maid01', 'submitStep', { signature: SIG, inspectionId: id, step: 1, failures: [] }).code, 'FORBIDDEN');
  assert.equal(run('maid01', 'startRoutine', { roomId: '205', round: 'morning' }).code, 'FORBIDDEN');
  ok('maid02', 'startRoutine', { roomId: '205', round: 'morning' });
  ok('head', 'startRoutine', { roomId: '305', round: 'morning' }); // หัวหน้าไม่จำกัดชั้น
});

test('แม่บ้านเห็นเฉพาะงานและข้อมูลของชั้นตัวเอง ส่วนหัวหน้า/แอดมิน/ฟรอนต์เห็นทั้งหมด', () => {
  const { db, ok } = fresh();
  ['203', '304'].forEach((r) => { ok('front', 'checkin', { roomId: r }); ok('front', 'checkout', { roomId: r }); });
  const u = (id) => db.users.find((x) => x.id === id);
  assert.deepEqual(Core.tasksFor(db, u('maid02')).map((t) => t.roomId), ['203']);
  assert.deepEqual(Core.tasksFor(db, u('maid03')).map((t) => t.roomId), ['304']);
  assert.equal(Core.tasksFor(db, u('maid01')).length, 0);
  ok('maid02', 'cleaned', { roomId: '203' });
  ok('maid03', 'cleaned', { roomId: '304' });
  const s2 = Core.scopeDb(db, u('maid02'));
  assert.deepEqual(s2.rooms.map((r) => r.floor).filter((v, i, a) => a.indexOf(v) === i), [2]);
  assert.equal(s2.rooms.length, 8);
  assert.deepEqual(s2.inspections.map((i) => i.roomId), ['203']);
  assert.equal(s2.users.length, 1);
  assert.equal(Core.scopeDb(db, u('head')), db);
  assert.equal(Core.scopeDb(db, u('admin')), db);
  assert.equal(Core.scopeDb(db, u('front')), db);
});

test('แม่บ้านที่ยังไม่ได้ตั้งชั้น: ไม่เห็นและไม่ทำอะไรเลย', () => {
  const { db, run } = fresh();
  const u = db.users.find((x) => x.id === 'maid05');
  u.floors = '';
  assert.equal(Core.scopeDb(db, u).rooms.length, 0);
  assert.equal(Core.apply(db, { user: u, nowMs: T0 }, 'cleaned', { roomId: '501' }).code, 'FORBIDDEN');
  assert.equal(Core.tasksFor(db, u).length, 0);
});

test('แม่บ้านหลายชั้น (floors = "1,2") เห็นและทำได้ทั้งสองชั้น', () => {
  const { db, ok } = fresh();
  db.users.find((x) => x.id === 'maid01').floors = '1,2';
  ok('front', 'checkin', { roomId: '203' });
  ok('front', 'checkout', { roomId: '203' });
  const u = db.users.find((x) => x.id === 'maid01');
  assert.deepEqual(Core.tasksFor(db, u).map((t) => t.roomId), ['203']);
  ok('maid01', 'cleaned', { roomId: '203' });
});

// ---------------------------------------------------------------------------
// ลายเซ็น + ข้อมูลฟอร์ม
// ---------------------------------------------------------------------------
function startedInsp(f, roomId, maid) {
  f.ok('front', 'checkin', { roomId });
  f.ok('front', 'checkout', { roomId });
  f.ok(maid, 'cleaned', { roomId, idSeed: 'sg' + roomId });
  return active(f.db, roomId).id;
}

test('ลายเซ็น: ทุกขั้นตอนต้องเซ็น ไม่เซ็น/เซ็นไม่ถูกรูปแบบ/ขีดสั้นเกินไปจะไม่ผ่านและไม่แก้ข้อมูลเลย', () => {
  const f = fresh();
  const id = startedInsp(f, '201', 'maid02');
  const bad = [undefined, '', 'abc', '320x120|10,10', '320x120|10,10,500,90', '320x120|10,10,50,60,100', '320x120||', 'x|1,2,3,4', 123];
  bad.forEach((sig) => {
    const r = f.run('maid02', 'submitStep', { inspectionId: id, step: 1, failures: [], signature: sig });
    assert.equal(r.code, 'NEED_SIGN', String(sig));
  });
  assert.equal(f.db.steps.length, 0);
  assert.equal(active(f.db, '201').step, 1);
  // ขั้นที่พบปัญหาก็ต้องเซ็นเช่นกัน
  assert.equal(f.run('maid02', 'submitStep', { inspectionId: id, step: 1, failures: [{ itemNo: 7 }] }).code, 'NEED_SIGN');
  assert.equal(room(f.db, '201').status, 'inspecting');
  // ยาวเกินกำหนดก็ไม่รับ (ลงเซลล์ Sheet ไม่ได้)
  const huge = '320x120|' + Array.from({ length: 6000 }, () => '10,10').join(',');
  assert.equal(f.run('maid02', 'submitStep', { inspectionId: id, step: 1, failures: [], signature: huge }).code, 'NEED_SIGN');
});

test('ลายเซ็น: เซ็นแล้วเก็บไว้กับผลตรวจของขั้นนั้น (ทั้งผ่านและพบปัญหา)', () => {
  const f = fresh();
  const id = startedInsp(f, '201', 'maid02');
  f.ok('maid02', 'submitStep', { inspectionId: id, step: 1, failures: [{ itemNo: 7 }], signature: SIG });
  assert.equal(f.db.steps.length, 1);
  assert.equal(f.db.steps[0].signature, SIG);
  assert.equal(f.db.steps[0].result, 'fail');
  f.ok('maid02', 'markFixed', { inspectionId: id });
  const SIG2 = '320x120|30,60,90,40,140,80,200,30';
  f.ok('maid02', 'submitStep', { inspectionId: id, step: 1, failures: [], signature: SIG2 });
  assert.equal(f.db.steps[1].signature, SIG2);
  assert.equal(f.db.steps[1].mode, 'recheck');
});

test('ลายเซ็น: bulkPass ต้องเซ็น และลายเซ็นเดียวถูกบันทึกกับทุกห้องที่ผ่าน', () => {
  const f = fresh();
  const a = startedInsp(f, '101', 'maid01'), b = startedInsp(f, '102', 'maid01');
  f.ok('maid01', 'submitStep', { inspectionId: a, step: 1, failures: [], signature: SIG });
  f.ok('maid01', 'submitStep', { inspectionId: b, step: 1, failures: [], signature: SIG });
  const items = [{ inspectionId: a, step: 2 }, { inspectionId: b, step: 2 }];
  assert.equal(f.run('head', 'bulkPass', { items }).code, 'NEED_SIGN');
  assert.equal(Core.inspOf(f.db, a).step, 2);
  const HS = '320x120|20,20,80,90,150,30,220,85,300,35';
  const r = f.ok('head', 'bulkPass', { items, signature: HS });
  assert.equal(r.result.passed.length, 2);
  const s2 = f.db.steps.filter((s) => s.step === 2);
  assert.deepEqual(s2.map((s) => s.signature), [HS, HS]);
});

test('ลายเซ็น: parseSignature อ่านเส้นกลับมาได้ครบ', () => {
  const p = Core.parseSignature('320x120|10,10,50,60|100,20');
  assert.equal(p.w, 320); assert.equal(p.h, 120);
  assert.deepEqual(p.strokes, [[[10, 10], [50, 60]], [[100, 20]]]);
  assert.ok(p.length > 60);
  assert.equal(Core.parseSignature('320x120|10,10,50'), null);
});

test('formData: ผลตรวจเรียงตามฟอร์มกระดาษ — ช่อง 1/2/3, ✓/✗, หมายเหตุ, ยอดรวม, ผู้เซ็น', () => {
  const f = fresh();
  const id = startedInsp(f, '201', 'maid02');
  let fd = Core.formData(f.db, id);
  assert.equal(fd.items.length, 25);
  assert.deepEqual(fd.totals, [0, 0, 0]);
  assert.deepEqual(fd.signers.map((s) => s.done), [false, false, false]);

  f.ok('maid02', 'submitStep', { inspectionId: id, step: 1, signature: SIG, failures: [{ itemNo: 14, kind: 'missing', found: 2, note: 'แขกดื่มไป 2 ขวด' }] });
  fd = Core.formData(f.db, id);
  assert.equal(fd.items[13].marks[0], 'fail');
  assert.match(fd.items[13].remark, /ขั้น 1 ขาด\/สูญหาย \(เหลือ 2\/4\) แขกดื่มไป 2 ขวด/);
  assert.equal(fd.items[0].marks[0], 'ok');
  assert.deepEqual(fd.totals, [24, 0, 0]);
  assert.equal(fd.items[0].marks[1], null, 'ขั้นที่ยังไม่ตรวจเป็นช่องว่าง');
  assert.equal(fd.signers[0].signature, SIG);
  assert.equal(fd.signers[0].result, 'fail');

  // แก้แล้วแต่ยังไม่ตรวจซ้ำ → ช่องของรายการนั้นว่าง (ยังไม่ยืนยัน)
  f.ok('maid02', 'markFixed', { inspectionId: id });
  fd = Core.formData(f.db, id);
  assert.equal(fd.items[13].marks[0], null);
  assert.match(fd.items[13].remark, /แก้ไขแล้ว/);
  assert.deepEqual(fd.totals, [24, 0, 0]);

  f.ok('maid02', 'submitStep', { inspectionId: id, step: 1, signature: SIG, failures: [] });
  f.ok('head', 'submitStep', { inspectionId: id, step: 2, signature: SIG, failures: [] });
  f.ok('front', 'submitStep', { inspectionId: id, step: 3, signature: SIG, failures: [] });
  fd = Core.formData(f.db, id);
  assert.deepEqual(fd.totals, [25, 25, 25]);
  assert.equal(fd.status, 'passed');
  assert.deepEqual(fd.signers.map((s) => s.userName), ['แม่บ้าน ชั้น 2', 'หัวหน้าแม่บ้าน', 'หัวหน้าฝ่ายต้อนรับ']);
  assert.ok(fd.signers.every((s) => s.signature === SIG && s.done));
  assert.equal(Core.formData(f.db, 'nope'), null);
});
