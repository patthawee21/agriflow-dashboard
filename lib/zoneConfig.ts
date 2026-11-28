import type { ZoneId } from './types/iot';

/**
 * Mapping กลางของทุกแปลง — ใช้ได้ทั้งฝั่ง server และ client
 * (ห้าม import อะไรที่ผูกกับ Node/server ในไฟล์นี้)
 */

/** แปลง (zone) → group_id ของ Node-RED */
export const ZONE_GROUP_IDS: Record<ZoneId, string> = {
  herb: 'group2',
  rice: 'group5',
  sunnhemp: 'group3',
  sunflower: 'group1',
  potted: 'group4',
};

/** แปลง (zone) → หมายเลขวาล์ว (valveId) */
export const ZONE_VALVE_IDS: Record<ZoneId, number> = {
  herb: 2,
  rice: 3,
  sunnhemp: 4,
  sunflower: 4,
  potted: 4,
};

export interface ZoneConfig {
  groupId: string;
  valveId: number;
}

/**
 * เวลารดน้ำต่อรอบของแต่ละวาล์ว ตามที่ตั้งไว้ใน Logic ของ Pump Engine (วินาที)
 * valve 2 = 600 (10 นาที) · valve 3 = 5280 (88 นาที) · valve 4 = 1200 (20 นาที)
 */
export const VALVE_RUNTIME_SECONDS: Record<number, number> = {
  2: 600,
  3: 5280,
  4: 1200,
};

/** เวลารดน้ำต่อรอบของวาล์ว (0 = ไม่รู้จักวาล์วนี้) */
export function getValveRuntimeSeconds(valveId: number): number {
  return VALVE_RUNTIME_SECONDS[valveId] ?? 0;
}

/** ค่าคอนฟิกของแปลงเดียว */
export function getZoneConfig(zone: ZoneId): ZoneConfig {
  return { groupId: ZONE_GROUP_IDS[zone], valveId: ZONE_VALVE_IDS[zone] };
}

/**
 * วาล์ว → แปลงที่ใช้วาล์วตัวนั้นร่วมกัน (สร้างจาก ZONE_VALVE_IDS อัตโนมัติ)
 * เช่น valve 4 รด 3 แปลง: sunnhemp, sunflower, potted
 */
export const VALVE_ZONE_IDS: Record<number, ZoneId[]> = Object.keys(
  ZONE_VALVE_IDS
).reduce<Record<number, ZoneId[]>>((acc, key) => {
  const zone = key as ZoneId;
  const valveId = ZONE_VALVE_IDS[zone];

  acc[valveId] = [...(acc[valveId] ?? []), zone];

  return acc;
}, {});

/** แปลงทั้งหมดที่แชร์วาล์วเดียวกับ zone นี้ (รวมตัวเองด้วย) */
export function zonesSharingValve(zone: ZoneId): ZoneId[] {
  return VALVE_ZONE_IDS[ZONE_VALVE_IDS[zone]] ?? [zone];
}

/** group_id → zone (คืน undefined ถ้าไม่รู้จัก) */
export function zoneFromGroup(groupId: string): ZoneId | undefined {
  const target = groupId.trim().toLowerCase();

  return (Object.keys(ZONE_GROUP_IDS) as ZoneId[]).find(
    (zone) => ZONE_GROUP_IDS[zone].toLowerCase() === target
  );
}
