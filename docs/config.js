// ตั้งค่าของโรงแรม — แก้ไฟล์นี้ไฟล์เดียว
window.APP_CONFIG = {
  // ใส่ URL ของ Apps Script Web App (ลงท้าย /exec) เพื่อต่อ Google Sheet จริง
  // เว้นว่างไว้ = โหมดทดลอง (ข้อมูลจำลอง เก็บในเครื่องนี้เท่านั้น)
  API_URL: 'https://script.google.com/macros/s/AKfycbyD_IXx9RhJD-Ul2hITxNS-5piECz0ElBOBj3A6edL7J6Cwxx_CAkIwgVB9fc8ktd5i4w/exec',

  HOTEL_NAME: 'โรงแรมของเรา',

  POLL_SECONDS: 15,      // ดึงงานใหม่ทุกกี่วินาที (ใช้เมื่อเปิดแอปอยู่)
  OVERDUE_MINUTES: 30    // ห้องค้างที่ขั้นใดเกินกี่นาทีให้ขึ้นสีแดง
};
