// ===== ชนิดข้อมูลหลักของระบบ AgriFlow =====

/** รหัสของ 5 แปลง (zone) */
export type ZoneId = 'herb' | 'rice' | 'sunnhemp' | 'sunflower' | 'potted';

/** ค่าที่วัดได้ของแปลง — มีเฉพาะค่าที่แปลงนั้นวัดจริง */
export interface ZoneValues {
  soilWaterKpa?: number; // ความชื้นในดิน (kPa)
  etoMmPerHour?: number; // ETo (mm/ชั่วโมง)
  soilTempC?: number; // อุณหภูมิในดิน (°C)
  soilHumidity?: number; // ความชื้นในดิน (%)
  soilMoisturePercent?: number; // ความชื้นในดิน (%)
}

/** ข้อมูลของแปลงหนึ่งแปลง */
export interface Zone {
  id: ZoneId;
  name: string;
  pumpOn: boolean;
  values: ZoneValues;
  /** หมายเลขวาล์วของแปลง (ตาม ZONE_VALVE_IDS) */
  valveId?: number;
  /** สถานะวาล์วแต่ละตัวจาก Node-RED เช่น { "2": true } */
  valves?: Record<string, boolean>;
}

/** สถานะวาล์วของแปลง ตามรูปแบบที่ Node-RED ส่งมา */
export interface ValveStatusEntry {
  groupId: string;
  valves: Record<string, boolean>;
}

/**
 * ค่าอากาศ + ETo (การ์ดแถวบน)
 * null = ยังไม่เคยได้รับค่านี้ — ไม่แต่งค่าขึ้นเอง แล้วค้างค่าล่าสุดไว้จนกว่าจะมีค่าใหม่มา
 */
export interface Weather {
  temperatureC: number | null;
  humidity: number | null;
  etoMmPerDay: number | null;
  /** ความกดอากาศ (hPa) — จากสถานีอากาศ S700 */
  pressureHpa?: number | null;
  /** ความเข้มแสง (lux) */
  lightLux?: number | null;
  /** ความเร็วลม (m/s) ที่ระดับใบพัด */
  windMs?: number | null;
  /** รังสีแสงอาทิตย์ (W/m²) */
  solarRadiationWm2?: number | null;
  /** น้ำฝนของวัน (mm) — ใช้หาน้ำฝนใช้การได้ */
  rainfallMm?: number | null;
}

/** ถังน้ำหลักของระบบ (null = ยังไม่เคยได้รับค่า) */
export interface WaterTank {
  levelPercent: number | null; // ระดับน้ำในถัง (%)
}

/**
 * คุณภาพสัญญาณ LoRa ของรีซีฟเวอร์ (Heltec V2)
 * เก็บเป็นข้อมูลของ "ลิงก์ LoRa" ที่รับแพ็กเก็ตนั้น ไม่ใช่ของเซนเซอร์แต่ละตัว
 * null = ยังไม่เคยได้รับค่านี้
 */
export interface LoraSignal {
  /** ความแรงสัญญาณ (dBm) — -30 ใกล้มาก, -120 อ่อนมาก */
  rssi: number | null;
  /** อัตราส่วนสัญญาณต่อสัญญาณรบกวน (dB) — ยิ่งมากยิ่งดี */
  snr: number | null;
  /** เวลาที่ได้รับค่าล่าสุด (ISO) */
  updatedAt: string | null;
}

/**
 * สถานะ "พักรดน้ำรอเติมน้ำ" ที่ Pump Logic Engine (Node-RED) รายงานมา
 * active = true เมื่อมีกลุ่มที่ยังต้องการน้ำแต่ถูกหยุดชั่วคราวเพราะน้ำหมด
 */
export interface PumpAlert {
  active: boolean;
  /** group ที่ถูกพัก เช่น ["group5"] */
  pausedGroups: string[];
  /** เวลาที่เหลือของกลุ่มที่พัก (วินาที) — มากที่สุดในกลุ่ม */
  remainingSeconds: number | null;
  /** เวลาที่เหลือแยกตาม group */
  remainingByGroup?: Record<string, number>;
  /** ข้อความจาก engine */
  message: string | null;
  /** ระดับน้ำตอนที่พัก (%) */
  waterLevel: number | null;
  /** ระดับน้ำที่ต้องถึงก่อนรดต่อ (%) */
  resumeThreshold: number | null;
  /** เวลาที่เว็บได้รับแจ้งเตือน (ISO) */
  at: string | null;
}

/** ช่วงเวลาของกราฟข้อมูลย้อนหลัง */
export type HistoryRange = '1h' | '6h' | '24h' | '7d';

/** หนึ่งจุดข้อมูลย้อนหลัง (ใช้กับกราฟ Section B) */
export interface HistoryPoint {
  /** epoch ms ของต้นนาทีที่เก็บค่า */
  ts: number;
  temperatureC: number | null;
  humidity: number | null;
  etoMmPerDay: number | null;
  pressureHpa: number | null;
  solarRadiationWm2: number | null;
  windMs: number | null;
  vpdKpa: number | null;
  /** ความแรงสัญญาณ LoRa (dBm) */
  rssi: number | null;
  /** SNR ของลิงก์ LoRa (dB) */
  snr: number | null;
}

/** ข้อมูลที่ GET /api/sensors/latest ตอบกลับ */
export interface FarmSnapshot {
  weather: Weather;
  zones: Zone[];
  waterTank: WaterTank;
  /** คุณภาพสัญญาณ LoRa จากรีซีฟเวอร์ */
  lora?: LoraSignal;
  /** แจ้งเตือนเมื่อปั๊มพักรอน้ำ (null = ไม่มี) */
  pumpAlert?: PumpAlert | null;
  /** สถานะวาล์วแยกตามแปลง */
  valveStatus?: Partial<Record<ZoneId, ValveStatusEntry>>;
  /** สถานะปั๊มตาม group_id */
  pumpStatus?: Record<string, boolean>;
  /** ข้อมูลย้อนหลัง — ส่งมาก็ต่อเมื่อเรียกด้วย ?range=1h|6h|24h|7d */
  history?: HistoryPoint[];
  updatedAt: string;
}

/** body ที่ POST /api/sensors/telemetry รับ (ส่งเฉพาะค่าที่มีก็ได้) */
export interface TelemetryPayload {
  temperature?: number;
  humidity?: number;
  etoMmPerDay?: number;
  pressure?: number;
  light?: number;
  wind_speed?: number;
  solar_radiation?: number;
  /** คุณภาพสัญญาณ LoRa — ส่งแบบแบนหรือในก้อน lora ก็ได้ */
  rssi?: number;
  snr?: number;
  lora?: Partial<LoraSignal>;
  zones?: Partial<Record<ZoneId, ZoneValues>>;
  /** รายงานสถานะพักรอน้ำจาก Pump Logic Engine */
  pumpAlert?: Partial<Omit<PumpAlert, 'at'>> | null;
}

/** หนึ่งจุดข้อมูลสำหรับกราฟ/ตารางประวัติ */
export interface SensorPoint {
  timestamp: Date;
  time: string;
  temperature: number;
  humidity: number;
  etoMmPerDay: number;
}

/** ประวัติการเปิด–ปิดปั๊มน้ำ */
export interface PumpLog {
  id: number;
  status: 'ON' | 'OFF';
  startedAt: Date;
  stoppedAt: Date | null;
  durationSeconds: number | null;
}

/** หน้าที่แสดงใน Sidebar */
export type PageKey = 'control' | 'docs' | 'storage' | 'debug';
