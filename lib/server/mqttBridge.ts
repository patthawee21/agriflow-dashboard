import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';

import { setZonePump, getStore } from './store';
import { ZONE_GROUP_IDS } from './nodered';
import { logEvent } from './debugLog';

import type { ZoneId } from '../types/iot';

/**
 * MQTT bridge (ฝั่ง server) — ฟังสถานะปั๊มจริงจาก Node-RED
 *
 * Node-RED publish:
 *   pump/control/group1..group5 → true / false  ← สถานะจริงหลังผ่าน safety
 *
 * ใช้ env MQTT_URL (เช่น mqtt://13.212.181.250:1883) ถ้าไม่ตั้งจะใช้ค่าเริ่มต้น
 */

const DEFAULT_MQTT_URL = 'mqtt://13.212.181.250:1883';

const STATE_TOPIC = 'pump/control/+';

/**
 * group1 = ปั๊มหลัก (O1) ไม่ใช่วาล์ว — Node-RED publish ทุกครั้งที่ปั๊มเริ่ม/หยุด
 * ถ้าเอามาเป็นสถานะแปลง การ์ดแปลงดอกไม้จะขึ้น/ลงตามปั๊มแทนวาล์ว 4
 * (วาล์ว 4 มีสถานะของตัวเองที่ pump/control/group4)
 */
const PUMP_MASTER_GROUP = 'group1';

/**
 * หลังสั่งจากเว็บ กี่ ms ที่จะไม่รับสถานะจาก Node-RED ที่ "ขัด" กับคำสั่ง
 * engine อาจ publish สถานะของรอบก่อนค้างมาหลังคำสั่งใหม่
 * → การ์ดจะกลับเป็น "หยุดทำงาน" ทั้งที่ปั๊มเพิ่งเริ่ม
 */
const REMOTE_STATE_GRACE_MS = 20000;

/**
 * หลังเชื่อมไม่สำเร็จ (auth ผิด / mqtt.connect throw) จะรอกี่ ms ก่อนสร้าง client ใหม่
 * มี cooldown เพราะ mqtt.js ถือ options ตอน connect ไว้ → ต้องสร้าง client ใหม่
 * จึงจะรับ env ที่แก้แล้ว แต่ไม่อยากสร้างใหม่ทุก request
 */
const RECONNECT_COOLDOWN_MS = 60000;

/** group1..5 → zone ของหน้าเว็บ */
const GROUP_ZONE_IDS: Record<string, ZoneId> = Object.fromEntries(
  (Object.entries(ZONE_GROUP_IDS) as [ZoneId, string][]).map(([zone, group]) => [
    group.toLowerCase(),
    zone,
  ])
);

export interface MqttStatus {
  enabled: boolean;
  url: string;
  connected: boolean;
  lastMessageAt: string | null;
  lastError: string | null;
}

/** สถานะที่ "ดูได้" — สร้างใหม่ทุกครั้งที่เริ่ม client ใหม่ */
interface BridgeStatus {
  connected: boolean;
  lastMessageAt: string | null;
  lastError: string | null;
}

/**
 * แยก 3 global ตามอายุของข้อมูล:
 * - agriflowMqtt     = client ที่ยังมีชีวิต ("ต่ออยู่/กำลังต่อ")
 * - agriflowMqttStatus = สถานะของ client รุ่นล่าสุด (handler ของรุ่นเก่าเขียนลง object ที่ตายแล้ว)
 * - agriflowMqttRetryAt = timestamp ก่อนหน้าที่ยังไม่ให้สร้าง client ใหม่
 */
const globalStore = globalThis as unknown as {
  agriflowMqtt?: MqttClient;
  agriflowMqttStatus?: BridgeStatus;
  agriflowMqttRetryAt?: number;
};

function getMqttUrl(): string {
  return (process.env.MQTT_URL?.trim() || DEFAULT_MQTT_URL).replace(/\/+$/, '');
}

/** ซ่อน username:password ใน URL ก่อนส่งออก API/log */
export function sanitizeUrl(url: string): string {
  return url.replace(/^(\w+:\/\/)[^@/]+@/, '$1***@');
}

/** บัญชี MQTT — ตั้งผ่าน MQTT_USERNAME / MQTT_PASSWORD หรือฝังใน MQTT_URL ก็ได้ */
function getCredentials(): { username?: string; password?: string } {
  const username = process.env.MQTT_USERNAME?.trim();
  const password = process.env.MQTT_PASSWORD?.trim();

  if (!username) return {};

  return { username, password };
}

/** แปลง payload MQTT (true/false, "ON"/"OFF", 1/0, {request:true}) เป็น boolean */
function parseState(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }

  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();

    if (['on', 'true', '1', 'open', 'opened'].includes(text)) return true;
    if (['off', 'false', '0', 'close', 'closed'].includes(text)) return false;

    return null;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    for (const key of ['request', 'state', 'status', 'pumpOn', 'value']) {
      if (key in record) {
        const parsed = parseState(record[key]);
        if (parsed !== null) return parsed;
      }
    }
  }

  return null;
}

/** เปิดการเชื่อมต่อ MQTT (เรียกซ้ำได้ ไม่สร้างซ้ำ) */
export function ensureMqttBridge(): void {
  // มี client อยู่แล้ว (ต่ออยู่ หรือกำลังต่อ) — ไม่สร้างซ้ำ
  if (globalStore.agriflowMqtt) return;

  // เพิ่งเชื่อมไม่สำเร็จ → เว้นช่วงก่อนสร้าง client ใหม่
  if (Date.now() < (globalStore.agriflowMqttRetryAt ?? 0)) return;

  const status: BridgeStatus = {
    connected: false,
    lastMessageAt: null,
    // คง error ล่าสุดไว้ให้ API ยังรายงานได้ระหว่างรอ cooldown
    lastError: globalStore.agriflowMqttStatus?.lastError ?? null,
  };

  globalStore.agriflowMqttStatus = status;

  const url = getMqttUrl();

  try {
    const client = mqtt.connect(url, {
      ...getCredentials(),
      reconnectPeriod: 5000,
      connectTimeout: 8000,
      clean: true,
      clientId: `agriflow-web-${Math.random().toString(16).slice(2, 10)}`,
    });

    globalStore.agriflowMqtt = client;

    client.on('connect', () => {
      status.connected = true;
      status.lastError = null;
      globalStore.agriflowMqttRetryAt = 0;

      client.subscribe(STATE_TOPIC, { qos: 0 }, (err) => {
        if (err) status.lastError = err.message;
      });
    });

    // ทั้งสาม event แปลว่า "ตอนนี้ไม่ต่อ" — ตัว client ยังมีชีวิตและ reconnect เอง
    for (const event of ['reconnect', 'offline', 'close'] as const) {
      client.on(event, () => {
        status.connected = false;
      });
    }

    client.on('error', (err) => {
      status.lastError = err.message;
      status.connected = false;

      const isAuthError = /not authorized|bad username|not authorised/i.test(
        err.message
      );

      // mqtt.js เก็บ options ไว้ตอน connect → ต้องทิ้ง client นี้แล้วสร้างใหม่
      // request ถัดไป (หลัง cooldown) จึงจะลองด้วย MQTT_USERNAME/PASSWORD ปัจจุบัน
      if (isAuthError) {
        globalStore.agriflowMqtt = undefined;
        globalStore.agriflowMqttRetryAt = Date.now() + RECONNECT_COOLDOWN_MS;

        client.end(true);
      }
    });

    client.on('message', (topic, payload) => {
      const group = topic.split('/').pop()?.toLowerCase() ?? '';

      if (group === PUMP_MASTER_GROUP) return;
      const zone = GROUP_ZONE_IDS[group];

      if (!zone) return;

      const raw = payload.toString();
      let parsed: boolean | null = null;

      try {
        parsed = parseState(JSON.parse(raw));
      } catch {
        parsed = parseState(raw);
      }

      if (parsed === null) return;

      status.lastMessageAt = new Date().toISOString();

      const before = getStore().zones.find((item) => item.id === zone)?.pumpOn;

      if (before === parsed) return; // ค่าไม่เปลี่ยน ไม่ต้อง log

      const commandedAt = getStore().pumpCommandAt[zone];

      // คำสั่งล่าสุดยังสด + สถานะที่มานี้ขัดกับคำสั่ง → ข้าม (ข้อความเก่าจากรอบก่อน)
      if (
        commandedAt !== undefined &&
        Date.now() - commandedAt < REMOTE_STATE_GRACE_MS
      ) {
        logEvent(
          'pump.state',
          'ข้ามสถานะจาก Node-RED ที่ขัดกับคำสั่งล่าสุด',
          { zone, group_id: group, topic, payload: raw.slice(0, 60) }
        );

        return;
      }

      setZonePump(zone, parsed, 'remote');

      logEvent('pump.state', `สถานะจริงจาก Node-RED: ${zone} = ${parsed ? 'ON' : 'OFF'}`, {
        zone,
        group_id: group,
        topic,
        payload: raw.slice(0, 60),
      });
    });
  } catch (err) {
    // mqtt.connect throw (เช่น URL ผิดรูป) → ไม่มี error event มาให้จับ
    // ต้องตั้ง cooldown เอง ไม่งั้นจะสร้าง client ใหม่ทุก request
    globalStore.agriflowMqtt = undefined;
    globalStore.agriflowMqttRetryAt = Date.now() + RECONNECT_COOLDOWN_MS;
    status.lastError = err instanceof Error ? err.message : String(err);
  }
}

/** สถานะการเชื่อมต่อ MQTT (สำหรับ API/หน้า Debug) */
export function getMqttStatus(): MqttStatus {
  const status = globalStore.agriflowMqttStatus;

  return {
    enabled: Boolean(status),
    url: sanitizeUrl(getMqttUrl()),
    connected: status?.connected ?? false,
    lastMessageAt: status?.lastMessageAt ?? null,
    lastError: status?.lastError ?? null,
  };
}

/** ให้ ensureMqttBridge() เริ่มใหม่ได้หลังแก้ env (ใช้ตอน dev/reload) */
export function resetMqttBridge(): void {
  globalStore.agriflowMqtt?.end(true);

  globalStore.agriflowMqtt = undefined;
  globalStore.agriflowMqttStatus = undefined;
  globalStore.agriflowMqttRetryAt = 0;
}
