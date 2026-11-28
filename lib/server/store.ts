import type {
  HistoryPoint,
  HistoryRange,
  LoraSignal,
  PumpAlert,
  WaterTank,
  Weather,
  Zone,
  ZoneId,
  ZoneValues,
} from '../types/iot';

import {
  HISTORY_BUCKET_MS,
  HISTORY_RETENTION_MS,
  historyRangeMs,
} from '../history';
import { vaporPressureDeficit } from '../vpd';
import { ZONE_VALVE_IDS } from '../zoneConfig';

/**
 * ที่เก็บข้อมูลฝั่ง server (in-memory)
 * มีของแค่ 2 อย่าง: ค่าอากาศ + 5 แปลง
 * รีสตาร์ท server = กลับไปค่าเริ่มต้น
 */

interface FarmStore {
  weather: Weather;
  waterTank: WaterTank;
  /** คุณภาพสัญญาณ LoRa ของรีซีฟเวอร์ (RSSI/SNR) */
  lora: LoraSignal;
  zones: Zone[];
  updatedAt: string;
  /** เวลาที่สั่งปั๊มล่าสุดของแต่ละแปลง (ใช้กันสถานะจาก Node-RED ย้อนกลับมาทับ) */
  pumpCommandAt: Partial<Record<ZoneId, number>>;
  /**
   * "ความตั้งใจ" ล่าสุดของแต่ละแปลงว่าเปิด/ปิดน้ำ
   * แยกจาก pumpOn เพราะแปลงหลายตัวใช้วาล์วเดียวกัน → pumpOn ที่แสดงต้องมาจากการรวม intent
   */
  valveIntent: Partial<Record<ZoneId, boolean>>;
  /** สถานะพักรดน้ำรอเติมน้ำ (จาก Pump Logic Engine) */
  pumpAlert: PumpAlert | null;
  /** ข้อมูลย้อนหลังในหน่วยความจำ (สูงสุด 7 วัน) — สำเนาถาวรอยู่ที่ Firebase */
  history: HistoryPoint[];
}

// ยังไม่ได้รับค่าจากเซนเซอร์ → null (ไม่แต่งค่าเริ่มต้นขึ้นเอง)
// ค่าที่รับมาจะค้างอยู่จนกว่าจะมีค่าใหม่มาแทน
const initialWeather: Weather = {
  temperatureC: null,
  humidity: null,
  etoMmPerDay: null,
  pressureHpa: null,
  lightLux: null,
  windMs: null,
  solarRadiationWm2: null,
  rainfallMm: null,
};

const initialWaterTank: WaterTank = {
  levelPercent: null,
};

// ยังไม่ได้รับแพ็กเก็ต LoRa → ไม่มีค่า (แสดง "--")
const initialLora: LoraSignal = {
  rssi: null,
  snr: null,
  updatedAt: null,
};

// ค่าเริ่มต้นของ 5 แปลง (แก้ตัวเลขที่แสดงบนหน้าเว็บได้ที่นี่)
// ค่าในแปลงเว้นว่างไว้ก่อน — จะแสดง "--" จนกว่า Node-RED จะส่งค่าจริงมา
const initialZones: Zone[] = [
  {
    id: 'herb',
    name: 'ไม้ยืนต้น',
    pumpOn: false,
    values: {},
    valveId: ZONE_VALVE_IDS.herb,
  },
  {
    id: 'rice',
    name: 'นาข้าว',
    pumpOn: false,
    values: {},
    valveId: ZONE_VALVE_IDS.rice,
  },
  {
    id: 'sunnhemp',
    name: 'แปลงดอกไม้ · ปอเทือง',
    pumpOn: false,
    values: {},
    valveId: ZONE_VALVE_IDS.sunnhemp,
  },
  {
    id: 'sunflower',
    name: 'แปลงดอกไม้ · ทานตะวัน',
    pumpOn: false,
    values: {},
    valveId: ZONE_VALVE_IDS.sunflower,
  },
  {
    id: 'potted',
    name: 'แปลงดอกไม้ · ไม้กระถาง',
    pumpOn: false,
    values: {},
    valveId: ZONE_VALVE_IDS.potted,
  },
];

// เก็บไว้ที่ globalThis เพื่อไม่ให้ค่าหายตอน Next.js โหลดโมดูลใหม่ (dev)
const globalStore = globalThis as unknown as { farmStore?: FarmStore };

function createStore(): FarmStore {
  return {
    weather: { ...initialWeather },
    waterTank: { ...initialWaterTank },
    lora: { ...initialLora },
    zones: initialZones.map((zone) => ({ ...zone, values: { ...zone.values } })),
    updatedAt: new Date().toISOString(),
    pumpCommandAt: {},
    valveIntent: {},
    pumpAlert: null,
    history: [],
  };
}

/** ดึงข้อมูลทั้งหมด (สร้างค่าเริ่มต้นให้ถ้ายังไม่มี) */
export function getStore(): FarmStore {
  if (!globalStore.farmStore) {
    globalStore.farmStore = createStore();
  }

  const store = globalStore.farmStore;

  // กันกรณี store ถูกสร้างจากโค้ดเวอร์ชันก่อนหน้า (dev hot reload) แล้วยังไม่มีฟิลด์ใหม่
  if (!store.waterTank) store.waterTank = { ...initialWaterTank };

  // store เก่ายังไม่มีฟิลด์คุณภาพสัญญาณ LoRa
  store.lora = { ...initialLora, ...store.lora };

  // เผื่อ store เก่ายังไม่มีฟิลด์สถานีอากาศที่เพิ่มใหม่
  store.weather = { ...initialWeather, ...store.weather };
  if (!store.pumpCommandAt) store.pumpCommandAt = {};
  if (!store.valveIntent) store.valveIntent = {};
  if (!Array.isArray(store.history)) store.history = [];

  // store ที่สร้างจากโค้ดเวอร์ชันเก่า/ถูกเขียนทับผิดรูป → สร้างชุดแปลงใหม่
  if (!Array.isArray(store.zones)) {
    store.zones = initialZones.map((zone) => ({
      ...zone,
      values: { ...zone.values },
    }));
  }

  for (const zone of store.zones) {
    if (typeof zone.valveId !== 'number') zone.valveId = ZONE_VALVE_IDS[zone.id];
  }

  return store;
}

// ==============================
// ตัวช่วย merge แบบ "ค่าว่างไม่ทับค่าเดิม"
// ==============================

/**
 * overlay = ค่าใหม่ (ที่ไม่ใช่ null) ชนะ
 * fill    = เติมเฉพาะช่องที่ยังว่าง (ใช้ตอนอ่านของเก่ามาเติมก่อนเขียนลงที่เก็บถาวร)
 */
type SnapshotMode = 'overlay' | 'fill';

const WEATHER_NUMBER_KEYS = [
  'temperatureC',
  'humidity',
  'etoMmPerDay',
  'pressureHpa',
  'lightLux',
  'windMs',
  'solarRadiationWm2',
  'rainfallMm',
] as const;

const ZONE_NUMBER_KEYS = [
  'soilWaterKpa',
  'etoMmPerHour',
  'soilTempC',
  'soilHumidity',
  'soilMoisturePercent',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** รวมค่าอากาศ — ค่าที่เป็น null/undefined/NaN คือ "ไม่มีข้อมูล" จึงคงค่าเดิมไว้ */
function mergeWeatherNumbers(
  base: Weather,
  patch: unknown,
  mode: SnapshotMode = 'overlay'
): Weather {
  if (!isRecord(patch)) return base;

  const next: Weather = { ...base };

  for (const key of WEATHER_NUMBER_KEYS) {
    const value = toFinite(patch[key]);

    if (value === null) continue;
    if (mode === 'fill' && toFinite(next[key]) !== null) continue;

    next[key] = value;
  }

  return next;
}

/** รวมค่าในแปลง — ค่าที่หายไปไม่ลบค่าเดิม */
function mergeZoneValues(
  base: ZoneValues,
  patch: unknown,
  mode: SnapshotMode = 'overlay'
): ZoneValues {
  if (!isRecord(patch)) return { ...base };

  const next: ZoneValues = { ...base };

  for (const key of ZONE_NUMBER_KEYS) {
    const value = toFinite(patch[key]);

    if (value === null) continue;
    if (mode === 'fill' && toFinite(next[key]) !== null) continue;

    next[key] = value;
  }

  return next;
}

/**
 * รวมสถานะแจ้งเตือนพักรดน้ำ
 * ฟิลด์ที่ส่งมาเป็น null/หายไป → คงค่าเดิม (กันหน้าเว็บขึ้น "--")
 */
function mergePumpAlertFields(
  base: PumpAlert | null,
  patch: unknown,
  mode: SnapshotMode = 'overlay'
): PumpAlert {
  const record = isRecord(patch) ? patch : {};
  // fill = ข้อมูลเก่าจากที่เก็บถาวร → ไม่ทับของใหม่ที่มีอยู่ในหน่วยความจำ
  const existing = mode === 'fill' ? base : null;

  const pausedGroupsFromPatch = Array.isArray(record.pausedGroups)
    ? record.pausedGroups.filter(
        (group): group is string => typeof group === 'string'
      )
    : null;

  const remainingByGroup: Record<string, number> = {
    ...(existing?.remainingByGroup ?? base?.remainingByGroup ?? {}),
  };

  if (isRecord(record.remainingByGroup)) {
    for (const [group, value] of Object.entries(record.remainingByGroup)) {
      const seconds = toFinite(value);

      if (seconds === null || seconds < 0) continue;

      remainingByGroup[group] = seconds;
    }
  }

  return {
    active: existing
      ? existing.active
      : typeof record.active === 'boolean'
        ? record.active
        : (base?.active ?? false),
    pausedGroups: existing
      ? existing.pausedGroups
      : (pausedGroupsFromPatch ?? base?.pausedGroups ?? []),
    remainingSeconds: existing
      ? existing.remainingSeconds
      : (toFinite(record.remainingSeconds) ?? base?.remainingSeconds ?? null),
    remainingByGroup,
    message: existing
      ? existing.message
      : typeof record.message === 'string'
        ? record.message
        : (base?.message ?? null),
    waterLevel: existing
      ? existing.waterLevel
      : (toFinite(record.waterLevel) ?? base?.waterLevel ?? null),
    resumeThreshold: existing
      ? existing.resumeThreshold
      : (toFinite(record.resumeThreshold) ?? base?.resumeThreshold ?? null),
    at: existing
      ? existing.at
      : typeof record.at === 'string'
        ? record.at
        : (base?.at ?? null),
  };
}

/** อัปเดตค่าอากาศ (ส่งเฉพาะค่าที่เปลี่ยน) */
export function updateWeather(patch: Partial<Weather>): Weather {
  const store = getStore();

  // merge เฉพาะฟิลด์ที่เป็นตัวเลขจริง → ค่าที่เคยได้รับค้างอยู่จนกว่าจะมีค่าใหม่ทับ
  // (ค่า null ที่หลุดเข้ามาต้องไม่ลบของเดิม)
  store.weather = mergeWeatherNumbers(store.weather, patch);
  store.updatedAt = new Date().toISOString();

  return store.weather;
}

/** อัปเดตระดับน้ำในถังหลัก */
export function updateWaterTank(patch: Partial<WaterTank>): WaterTank {
  const store = getStore();
  const level = toFinite(patch.levelPercent);

  // null = ยังไม่มีค่าระดับน้ำ → คงค่าเดิมไว้ ไม่เขียนทับ
  if (level !== null) store.waterTank.levelPercent = level;
  store.updatedAt = new Date().toISOString();

  return store.waterTank;
}

/** ช่วงค่าที่เป็นไปได้จริงของลิงก์ LoRa — ค่าที่หลุดช่วงถือว่า "ไม่มีข้อมูล" */
const RSSI_RANGE: [number, number] = [-200, 0];
const SNR_RANGE: [number, number] = [-40, 40];

function clampLora(value: unknown, [min, max]: [number, number]): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;

  return value >= min && value <= max ? value : null;
}

/**
 * อัปเดตคุณภาพสัญญาณ LoRa (RSSI/SNR) จากรีซีฟเวอร์
 * ค่าที่หายไปหรือไม่ถูกต้อง → คงค่าเดิมไว้ (ไม่เขียน null ทับ)
 */
export function updateLoraSignal(patch: Partial<LoraSignal>): LoraSignal {
  const store = getStore();
  const rssi = clampLora(patch.rssi, RSSI_RANGE);
  const snr = clampLora(patch.snr, SNR_RANGE);

  if (rssi !== null) store.lora.rssi = rssi;
  if (snr !== null) store.lora.snr = snr;

  if (rssi !== null || snr !== null) {
    const now = new Date().toISOString();

    store.lora.updatedAt = now;
    store.updatedAt = now;
  }

  return store.lora;
}

/** อัปเดตค่าของแปลงตาม id (ส่งเฉพาะค่าที่เปลี่ยน) */
export function updateZoneValues(
  id: ZoneId,
  values: ZoneValues
): Zone | undefined {
  const store = getStore();
  const zone = store.zones.find((item) => item.id === id);

  if (!zone) return undefined;

  zone.values = mergeZoneValues(zone.values, values);
  store.updatedAt = new Date().toISOString();

  return zone;
}

/**
 * รวมสถานะวาล์วที่แปลงหลายตัวใช้ร่วมกัน
 * วาล์วตัวเดียวรดได้หลายแปลง → เปิดถ้ามีอย่างน้อย 1 แปลงต้องการน้ำ (intent = true)
 * แล้วเขียนสถานะเดียวกันลงการ์ดทุกใบที่ใช้วาล์วนั้น
 */
export function reconcileSharedValves(): Zone[] {
  const store = getStore();
  const byValve = new Map<string, Zone[]>();

  for (const zone of store.zones) {
    const key = String(zone.valveId ?? ZONE_VALVE_IDS[zone.id]);
    const list = byValve.get(key) ?? [];

    list.push(zone);
    byValve.set(key, list);
  }

  const touched: Zone[] = [];

  for (const [key, group] of byValve) {
    // ยังไม่มีความตั้งใจของใครในวาล์วนี้ → ไม่ต้องคำนวณทับ
    if (!group.some((zone) => store.valveIntent[zone.id] !== undefined)) {
      continue;
    }

    const open = group.some((zone) => store.valveIntent[zone.id] === true);
    let changed = false;

    for (const zone of group) {
      zone.valves = { ...(zone.valves ?? {}), [key]: open };

      if (zone.pumpOn !== open) {
        zone.pumpOn = open;
        changed = true;
      }

      touched.push(zone);
    }

    if (changed) store.updatedAt = new Date().toISOString();
  }

  return touched;
}

/**
 * เปิด–ปิดปั๊มของแปลง
 * source = 'local' คือผู้ใช้สั่งจากหน้าเว็บ (จะบันทึกเวลาไว้กันสถานะเก่าทับ)
 * source = 'remote' คือค่าที่อ่านมาจาก Node-RED
 */
export function setZonePump(
  id: ZoneId,
  on: boolean,
  source: 'local' | 'remote' = 'local'
): Zone | undefined {
  const store = getStore();
  const zone = store.zones.find((item) => item.id === id);

  if (!zone) return undefined;

  if (source === 'local') {
    store.pumpCommandAt[id] = Date.now();
  }

  // ความตั้งใจของแปลงนี้คือค่าล่าสุดที่สั่ง/รายงานมา
  store.valveIntent[id] = on;

  // ค่าไม่เปลี่ยน = ไม่ต้องขยับ updatedAt (กัน updatedAt ใหม่ทุกครั้งที่ poll)
  if (zone.pumpOn === on) {
    reconcileSharedValves();

    return zone;
  }

  zone.pumpOn = on;
  store.updatedAt = new Date().toISOString();

  // วาล์วที่ใช้ร่วมกันต้องขึ้นตรงกันทุกใบ
  reconcileSharedValves();

  return zone;
}

/**
 * อัปเดตสถานะวาล์วของแปลง (จาก valveStatus ที่ Node-RED ส่งมา)
 * pumpOn ของแปลงจะอิงวาล์วตัวหลักของแปลงนั้น (zone.valveId)
 */
export function updateZoneValves(
  id: ZoneId,
  valves: Record<string, boolean>
): Zone | undefined {
  const store = getStore();
  const zone = store.zones.find((item) => item.id === id);

  if (!zone) return undefined;

  zone.valves = { ...zone.valves, ...valves };

  const mainValve = String(zone.valveId ?? ZONE_VALVE_IDS[id]);
  const mainState = zone.valves[mainValve];

  if (typeof mainState === 'boolean') {
    // ใช้เป็นความตั้งใจของแปลงนี้ ไม่ใช่เขียน pumpOn ตรง ๆ
    // (ไม่งั้นแปลงที่ใช้วาล์วร่วมกันจะทับสถานะกันไปมา)
    store.valveIntent[id] = mainState;
  }

  // วาล์วเดียว/วาล์วใช้ร่วม → pumpOn ของทุกแปลงในวาล์วเดียวกันมาจาก intent ชุดเดียวกัน
  reconcileSharedValves();
  store.updatedAt = new Date().toISOString();

  return zone;
}

/** แปลงทุกตัว (รวมตัวเอง) ที่ใช้ valve เดียวกับ zone นี้ */
export function zonesInSameValveGroup(zoneId: ZoneId): Zone[] {
  const store = getStore();
  const zone = store.zones.find((item) => item.id === zoneId);

  if (!zone) return [];

  const valveId = zone.valveId ?? ZONE_VALVE_IDS[zoneId];

  return store.zones.filter(
    (other) => (other.valveId ?? ZONE_VALVE_IDS[other.id]) === valveId
  );
}

/**
 * ตั้งความตั้งใจให้ทุกแปลงที่ใช้ valve เดียวกัน (คำสั่งระดับ “วาล์ว” ไม่ใช่รายแปลง)
 * ใช้เมื่อ UI รวมแปลงที่ใช้วาล์วร่วมกันเป็นหน่วยเดียวแล้ว
 */
export function setValveGroupIntent(zoneId: ZoneId, on: boolean): Zone[] {
  const store = getStore();
  const group = zonesInSameValveGroup(zoneId);

  for (const zone of group) {
    store.valveIntent[zone.id] = on;
  }

  reconcileSharedValves();

  return group;
}

/**
 * แปลงอื่นที่ยังใช้ “วาล์วเดียวกัน” และต้องการน้ำอยู่
 * ใช้บล็อกการปิดวาล์วที่จะตัดน้ำแปลงอื่น
 */
export function getValveHolders(zoneId: ZoneId): Zone[] {
  const store = getStore();
  const zone = store.zones.find((item) => item.id === zoneId);

  if (!zone) return [];

  const valveId = zone.valveId ?? ZONE_VALVE_IDS[zoneId];

  return store.zones.filter((other) => {
    if (other.id === zoneId) return false;

    const otherValve = other.valveId ?? ZONE_VALVE_IDS[other.id];

    if (otherValve !== valveId) return false;

    // ใช้ intent เท่านั้น — pumpOn ที่แสดงถูกรวมมาจากวาล์วเดียวกัน จึงไม่ใช่ “ความต้องการน้ำ” ของแปลงนั้น
    return store.valveIntent[other.id] === true;
  });
}

/** เวลาที่สั่งปั๊มล่าสุดของแต่ละแปลง */
export function getPumpCommandAt(): Partial<Record<ZoneId, number>> {
  return getStore().pumpCommandAt ?? {};
}

/**
 * อัปเดต/ล้างแจ้งเตือน "พักรดน้ำรอเติมน้ำ"
 * ฟิลด์ที่เป็น null/หายไป (เช่น waterLevel ที่ engine ไม่ส่งมา) จะคงค่าเดิมไว้
 */
export function updatePumpAlert(patch: Partial<PumpAlert> | null): PumpAlert | null {
  const store = getStore();

  if (patch === null) {
    store.pumpAlert = null;

    return null;
  }

  store.pumpAlert = mergePumpAlertFields(store.pumpAlert, {
    ...patch,
    at: patch.at ?? new Date().toISOString(),
  });

  return store.pumpAlert;
}

/** แจ้งเตือนปั๊มล่าสุด */
export function getPumpAlert(): PumpAlert | null {
  return getStore().pumpAlert ?? null;
}

/** มีค่าจริงจากเซนเซอร์แล้วหรือยัง (ใช้ตัดสินว่าจะ hydrate/persist ไหม) */
export function hasLiveData(): boolean {
  const store = getStore();

  const weatherHasValue = Object.values(store.weather).some(
    (value) => typeof value === 'number' && Number.isFinite(value)
  );

  const tankHasValue =
    typeof store.waterTank.levelPercent === 'number' &&
    Number.isFinite(store.waterTank.levelPercent);

  const loraHasValue =
    typeof store.lora?.rssi === 'number' || typeof store.lora?.snr === 'number';

  const zoneHasValue = store.zones.some(
    (zone) => Object.keys(zone.values ?? {}).length > 0
  );

  return weatherHasValue || tankHasValue || loraHasValue || zoneHasValue;
}

/** ก้อนข้อมูลที่บันทึกลงที่เก็บถาวร */
export interface StoreSnapshot {
  version: 1;
  savedAt: string;
  updatedAt: string;
  weather: Weather;
  waterTank: WaterTank;
  lora: LoraSignal;
  zones: Zone[];
  pumpCommandAt: Partial<Record<ZoneId, number>>;
  valveIntent: Partial<Record<ZoneId, boolean>>;
  pumpAlert: PumpAlert | null;
}

/** ดึงก้อนข้อมูลปัจจุบันไปบันทึก */
export function exportSnapshot(): StoreSnapshot {
  const store = getStore();

  return {
    version: 1,
    savedAt: new Date().toISOString(),
    updatedAt: store.updatedAt,
    weather: { ...store.weather },
    waterTank: { ...store.waterTank },
    lora: { ...store.lora },
    zones: store.zones.map((zone) => ({
      ...zone,
      values: { ...(zone.values ?? {}) },
      valves: { ...(zone.valves ?? {}) },
    })),
    pumpCommandAt: { ...(store.pumpCommandAt ?? {}) },
    valveIntent: { ...(store.valveIntent ?? {}) },
    pumpAlert: store.pumpAlert ? { ...store.pumpAlert } : null,
  };
}

/**
 * คืนค่าจาก snapshot ที่เคยบันทึกไว้ (ใช้ตอน cold start / sync จาก Firebase)
 * คืน true ถ้าใช้ snapshot ได้
 *
 * mode = 'overlay' (ค่าใหม่ที่ไม่ใช่ null ชนะ) เป็นค่าปกติ
 * mode = 'fill'    เติมเฉพาะช่องที่ยังว่าง — ใช้ตอนจะเขียนทับที่เก็บถาวร
 *                  เพื่อไม่ให้ข้อมูลที่ฝั่งนี้ยังไม่มีไปลบข้อมูลที่มีอยู่แล้ว
 */
export function importSnapshot(
  raw: unknown,
  options: { mode?: SnapshotMode } = {}
): boolean {
  if (!isRecord(raw)) return false;

  const snapshot = raw as Partial<StoreSnapshot>;
  const mode: SnapshotMode = options.mode ?? 'overlay';

  // snapshot ที่ไม่มีฟิลด์ที่รู้จักเลย = อ่านผิดพลาด/ว่างเปล่า → ไม่ต้องแตะ store
  const hasKnownField =
    isRecord(snapshot.weather) ||
    isRecord(snapshot.waterTank) ||
    isRecord(snapshot.lora) ||
    Array.isArray(snapshot.zones) ||
    isRecord(snapshot.pumpAlert);

  if (!hasKnownField) return false;

  const store = getStore();

  if (isRecord(snapshot.weather)) {
    store.weather = mergeWeatherNumbers(store.weather, snapshot.weather, mode);
  }

  const tankLevel = isRecord(snapshot.waterTank)
    ? toFinite(snapshot.waterTank.levelPercent)
    : null;

  if (
    tankLevel !== null &&
    (mode === 'overlay' || toFinite(store.waterTank.levelPercent) === null)
  ) {
    store.waterTank.levelPercent = tankLevel;
  }

  // ลิงก์ LoRa: เติมเฉพาะช่องว่างใน mode 'fill' (ค่าใหม่ชนะใน mode 'overlay')
  if (isRecord(snapshot.lora)) {
    const rssi = clampLora(snapshot.lora.rssi, RSSI_RANGE);
    const snr = clampLora(snapshot.lora.snr, SNR_RANGE);

    if (rssi !== null && (mode === 'overlay' || store.lora.rssi === null)) {
      store.lora.rssi = rssi;
    }

    if (snr !== null && (mode === 'overlay' || store.lora.snr === null)) {
      store.lora.snr = snr;
    }

    if (
      (rssi !== null || snr !== null) &&
      typeof snapshot.lora.updatedAt === 'string'
    ) {
      store.lora.updatedAt = snapshot.lora.updatedAt;
    }
  }

  if (Array.isArray(snapshot.zones)) {
    for (const saved of snapshot.zones) {
      if (!isRecord(saved) || typeof saved.id !== 'string') continue;

      const zone = store.zones.find((item) => item.id === saved.id);

      if (!zone) continue;

      zone.values = mergeZoneValues(zone.values, saved.values, mode);

      if (isRecord(saved.valves)) {
        const valves: Record<string, boolean> = { ...(zone.valves ?? {}) };

        for (const [key, value] of Object.entries(saved.valves)) {
          if (typeof value !== 'boolean') continue;
          if (mode === 'fill' && typeof valves[key] === 'boolean') continue;

          valves[key] = value;
        }

        zone.valves = valves;
      }

      if (typeof saved.pumpOn === 'boolean') zone.pumpOn = saved.pumpOn;
      if (typeof saved.valveId === 'number') zone.valveId = saved.valveId;
    }
  }

  if (isRecord(snapshot.pumpCommandAt)) {
    const merged: Partial<Record<ZoneId, number>> = {
      ...(store.pumpCommandAt ?? {}),
    };

    for (const [key, value] of Object.entries(snapshot.pumpCommandAt)) {
      const at = toFinite(value);

      if (at === null) continue;
      if (mode === 'fill' && typeof merged[key as ZoneId] === 'number') continue;

      merged[key as ZoneId] = at;
    }

    store.pumpCommandAt = merged;
  }

  if (isRecord(snapshot.valveIntent)) {
    const merged: Partial<Record<ZoneId, boolean>> = {
      ...(store.valveIntent ?? {}),
    };

    for (const [key, value] of Object.entries(snapshot.valveIntent)) {
      if (typeof value !== 'boolean') continue;
      if (mode === 'fill' && typeof merged[key as ZoneId] === 'boolean') continue;

      merged[key as ZoneId] = value;
    }

    store.valveIntent = merged;
  }

  // pumpAlert: null ใน Firebase = ไม่มีข้อมูล (ไม่ใช่ "ล้างแจ้งเตือน") → คงของเดิมไว้
  if (isRecord(snapshot.pumpAlert)) {
    store.pumpAlert = mergePumpAlertFields(
      store.pumpAlert,
      snapshot.pumpAlert,
      mode
    );
  }

  // updatedAt ใช้เป็นตัวตัดสินว่า snapshot ใหม่กว่าในหน่วยความจำหรือไม่ → ขยับไปข้างหน้าเท่านั้น
  if (typeof snapshot.updatedAt === 'string') {
    const incoming = Date.parse(snapshot.updatedAt);
    const current = Date.parse(store.updatedAt);

    if (Number.isFinite(incoming) && (!Number.isFinite(current) || incoming > current)) {
      store.updatedAt = snapshot.updatedAt;
    }
  }

  return true;
}

// ==============================
// ข้อมูลย้อนหลัง (Time-series)
// ==============================

function toFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * บันทึกค่าปัจจุบันเป็นจุดข้อมูลย้อนหลัง
 * รวมค่าที่อยู่ในนาทีเดียวกันเป็นจุดเดียว → เก็บ 7 วันได้โดยไม่บวม
 * คืนจุดที่บันทึก เพื่อให้ caller ส่งต่อไปเก็บที่ Firebase
 */
export function appendHistoryPoint(): HistoryPoint {
  const store = getStore();
  const { weather } = store;
  const ts = Math.floor(Date.now() / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;

  const point: HistoryPoint = {
    ts,
    temperatureC: toFinite(weather.temperatureC),
    humidity: toFinite(weather.humidity),
    etoMmPerDay: toFinite(weather.etoMmPerDay),
    pressureHpa: toFinite(weather.pressureHpa),
    solarRadiationWm2: toFinite(weather.solarRadiationWm2),
    windMs: toFinite(weather.windMs),
    vpdKpa: vaporPressureDeficit(weather.temperatureC, weather.humidity),
    // คุณภาพสัญญาณของลิงก์ LoRa ที่รับแพ็กเก็ตนี้
    rssi: toFinite(store.lora.rssi),
    snr: toFinite(store.lora.snr),
  };

  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  const kept = store.history.filter((item) => item.ts >= cutoff);
  const last = kept[kept.length - 1];

  if (last && last.ts === ts) {
    kept[kept.length - 1] = point;
  } else {
    kept.push(point);
  }

  store.history = kept;

  return point;
}

/** จุดข้อมูลย้อนหลังภายในช่วงเวลาที่ขอ (เรียงจากเก่า → ใหม่) */
export function getHistory(range: HistoryRange): HistoryPoint[] {
  const store = getStore();
  const since = Date.now() - historyRangeMs(range);

  return store.history.filter((point) => point.ts >= since);
}
