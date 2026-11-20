/*
 * demo.js — สร้างข้อมูลทดลองที่มีห้องอยู่ในสถานะต่าง ๆ ให้กดดู flow ได้ทันที
 * (ใช้เฉพาะโหมดทดลอง เมื่อ config.js ยังไม่ได้ใส่ API_URL)
 * สร้างโดยเรียก Core.apply จริง ๆ ข้อมูลจึงตรงกับกฎของระบบเสมอ
 */
var Demo = (function () {
  'use strict';
  var C = (typeof Core !== 'undefined') ? Core : require('./core.js');

  function make(nowMs) {
    var db = C.seedDb();
    function user(id) { for (var i = 0; i < db.users.length; i++) if (db.users[i].id === id) return db.users[i]; }
    function run(uid, minsAgo, action, payload) {
      var r = C.apply(db, { user: user(uid), nowMs: nowMs - minsAgo * 60000 }, action, payload);
      if (!r.ok) throw new Error('demo ' + action + ' ' + JSON.stringify(payload) + ': ' + r.message);
      return r;
    }
    function inspId(roomId) { var i = C.activeInspOf(db, roomId); return i && i.id; }
    function lastInsp(roomId) {
      var found = null;
      db.inspections.forEach(function (i) { if (i.roomId === roomId) found = i; });
      return found.id;
    }
    function pass(uid, mins, roomId, step) { run(uid, mins, 'submitStep', { inspectionId: inspId(roomId), step: step, failures: [] }); }

    // ห้องที่มีแขกพัก
    ['101', '102', '104', '105', '107', '201', '203', '204', '206', '301', '302', '305', '308', '401', '403', '501', '503']
      .forEach(function (r) { run('front', 400, 'checkin', { roomId: r }); });

    // ผ่านครบแล้ว (ประวัติ + พร้อมขาย)
    run('front', 420, 'checkin', { roomId: '303' });
    run('front', 300, 'checkout', { roomId: '303' });
    run('maid03', 280, 'cleaned', { roomId: '303', idSeed: 'd303' });
    pass('maid03', 270, '303', 1); pass('head', 250, '303', 2); pass('front', 230, '303', 3);

    // รอตรวจขั้น 3 มานาน (เกินเวลาที่กำหนด)
    run('front', 420, 'checkin', { roomId: '103' });
    run('front', 90, 'checkout', { roomId: '103' });
    run('maid01', 70, 'cleaned', { roomId: '103', idSeed: 'd103' });
    pass('maid01', 60, '103', 1); pass('head', 40, '103', 2);

    // รอหัวหน้าแม่บ้านตรวจขั้น 2
    run('front', 420, 'checkin', { roomId: '106' });
    run('front', 50, 'checkout', { roomId: '106' });
    run('maid01', 35, 'cleaned', { roomId: '106', idSeed: 'd106' });
    pass('maid01', 30, '106', 1);
    run('front', 420, 'checkin', { roomId: '306' });
    run('front', 40, 'checkout', { roomId: '306' });
    run('maid03', 28, 'cleaned', { roomId: '306', idSeed: 'd306' });
    pass('maid03', 22, '306', 1);

    // รอทำความสะอาด (บางห้องเกินเวลา)
    run('front', 420, 'checkin', { roomId: '202' });
    run('front', 20, 'checkout', { roomId: '202' });
    run('front', 420, 'checkin', { roomId: '205' });
    run('front', 75, 'checkout', { roomId: '205' });
    run('front', 420, 'checkin', { roomId: '402' });
    run('front', 8, 'checkout', { roomId: '402' });

    // แม่บ้านทำความสะอาดเสร็จ รอตรวจขั้น 1
    run('front', 420, 'checkin', { roomId: '207' });
    run('front', 30, 'checkout', { roomId: '207' });
    run('maid02', 15, 'cleaned', { roomId: '207', idSeed: 'd207' });

    // พบปัญหาที่ขั้น 1 รอแม่บ้านแก้
    run('front', 420, 'checkin', { roomId: '208' });
    run('front', 60, 'checkout', { roomId: '208' });
    run('maid02', 40, 'cleaned', { roomId: '208', idSeed: 'd208' });
    run('maid02', 25, 'submitStep', {
      inspectionId: inspId('208'), step: 1,
      failures: [
        { itemNo: 14, kind: 'missing', found: 2, note: 'แขกดื่มไป 2 ขวด' },
        { itemNo: 9, kind: 'damaged', found: 1, note: 'แก้วไวน์แตก 1 ใบ' }
      ]
    });

    // ตรวจรอบเช้า: ผ่านแล้ว + กำลังตรวจซ้ำที่ขั้น 2
    run('head', 200, 'startRoutineMany', { round: 'morning', roomIds: ['108', '406', '407', '408', '304'], idSeed: 'dm1' });
    ['108', '406', '407', '408', '304'].forEach(function (r) {
      pass('maid0' + r.charAt(0), 190, r, 1); // แม่บ้านของชั้นนั้น
    });
    ['108', '406', '407', '408'].forEach(function (r) { pass('head', 170, r, 2); pass('front', 150, r, 3); });
    run('head', 120, 'submitStep', {
      inspectionId: inspId('304'), step: 2, failures: [{ itemNo: 7, kind: 'missing', found: 0, note: 'ไม่พบรีโมททีวี' }]
    });
    run('maid03', 100, 'markFixed', { inspectionId: inspId('304') });

    return db;
  }

  return { make: make };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = Demo; }
