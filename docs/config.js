// ตั้งค่าของโรงแรม — แก้ไฟล์นี้ไฟล์เดียว
window.APP_CONFIG = {
  // ใส่ URL ของ Apps Script Web App (ลงท้าย /exec) เพื่อต่อ Google Sheet จริง
  // เว้นว่างไว้ = โหมดทดลอง (ข้อมูลจำลอง เก็บในเครื่องนี้เท่านั้น)
  API_URL: 'https://script.google.com/macros/s/AKfycbz2nSe1w1AyRNgNtRWk0tCZUVtBsD_2b3uXMq_gSMGemrUf7u4Xg8KBkpcak3z76_S-IA/exec',

  HOTEL_NAME: 'โรงแรมของเรา',

  POLL_SECONDS: 15,      // ดึงงานใหม่ทุกกี่วินาที (ใช้เมื่อเปิดแอปอยู่)
  OVERDUE_MINUTES: 30    // ห้องค้างที่ขั้นใดเกินกี่นาทีให้ขึ้นสีแดง
};
