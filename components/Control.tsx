import { AlertTriangle, RefreshCw } from 'lucide-react';

import PumpPauseAlert from './PumpPauseAlert';
import EnvMetrics from './dashboard/EnvMetrics';
import EnvChart from './dashboard/EnvChart';
import CropZones from './dashboard/CropZones';
import WaterSection from './dashboard/WaterSection';
import LoraSignalSection from './dashboard/LoraSignal';

import type {
  LoraSignal,
  PumpAlert,
  WaterTank,
  Weather,
  Zone,
  ZoneId,
} from '../lib/types/iot';

interface ControlProps {
  weather: Weather;
  waterTank: WaterTank | null;
  zones: Zone[];
  busyZone: ZoneId | null;
  onTogglePump: (zoneId: ZoneId, scope?: 'valve') => void;
  /** คำเตือนตอนสั่งปิดวาล์วที่แปลงอื่นยังใช้อยู่ */
  valveWarning?: { title: string; detail: string } | null;
  onDismissValveWarning?: () => void;
  lastUpdated: Date;
  deviceOnline: boolean;
  /** สถานะพักรดน้ำรอเติมน้ำจาก Pump Logic Engine */
  pumpAlert?: PumpAlert | null;
  /** คุณภาพสัญญาณ LoRa จากรีซีฟเวอร์ (RSSI/SNR) */
  lora?: LoraSignal | null;
  /** เวลาที่สั่งเปิดปั๊มล่าสุดของแต่ละแปลง (epoch ms) — ใช้ทำ countdown */
  pumpCommandAt?: Partial<Record<ZoneId, number>>;
}

/**
 * หน้า Control — Single Dashboard 4 Sections
 *   A: Environmental Monitoring (metric cards 2 แถว)
 *   B: Environmental Data Visualization (time-series chart)
 *   C: Crop Monitoring (2 การ์ด + 1 การ์ดกว้าง)
 *   D: Water Resources & Irrigation
 */
export default function Control({
  weather,
  waterTank,
  zones,
  busyZone,
  onTogglePump,
  valveWarning,
  onDismissValveWarning,
  lastUpdated,
  deviceOnline,
  pumpAlert = null,
  lora = null,
  pumpCommandAt = {},
}: ControlProps) {
  const updatedLabel = lastUpdated.toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="dash-container">
      <header className="dash-header">
        <div className="dash-header-copy">
          <span className="dash-eyebrow">
            Smart Agriculture IoT Dashboard
          </span>
          <h1>ศูนย์ควบคุมฟาร์ม AgriFlow</h1>
          <p>
            ติดตามสภาพแวดล้อม การคายระเหย และสถานะการให้น้ำของทุกแปลง
            พร้อมข้อมูลย้อนหลังแบบเรียลไทม์
          </p>
        </div>

        <div className="dash-header-meta">
          <span className={`dash-live ${deviceOnline ? 'is-online' : ''}`}>
            <i />
            {deviceOnline ? 'LIVE DATA' : 'OFFLINE'}
          </span>

          <span className="dash-updated">
            <RefreshCw size={13} />
            อัปเดต {updatedLabel}
          </span>

          <button
            type="button"
            className="outline-button"
            onClick={() => window.location.reload()}
          >
            <RefreshCw size={15} /> รีเฟรช
          </button>
        </div>
      </header>

      {/* แจ้งเตือนเมื่อปั๊มพักรดน้ำรอน้ำ (พร้อมเวลาที่เหลือ) */}
      <PumpPauseAlert alert={pumpAlert} />

      {valveWarning ? (
        <div className="notice-banner" role="alert">
          <div className="notice-icon">
            <AlertTriangle size={15} />
          </div>
          <div>
            <strong>{valveWarning.title}</strong>
            <span>{valveWarning.detail}</span>
          </div>
          {onDismissValveWarning ? (
            <button
              type="button"
              className="outline-button"
              style={{ marginLeft: 'auto' }}
              onClick={onDismissValveWarning}
            >
              ปิดข้อความ
            </button>
          ) : null}
        </div>
      ) : null}

      <EnvMetrics
        weather={weather}
        updatedAt={lastUpdated}
        online={deviceOnline}
      />

      <EnvChart />

      <CropZones
        zones={zones}
        busyZone={busyZone}
        onTogglePump={onTogglePump}
        etoMmPerDay={weather.etoMmPerDay}
        pumpCommandAt={pumpCommandAt}
      />

      <WaterSection
        waterTank={waterTank}
        zones={zones}
        etoMmPerDay={weather.etoMmPerDay}
        rainfallMm={weather.rainfallMm ?? null}
      />

      <LoraSignalSection lora={lora} />

      <div className="dash-footnote">
        AgriFlow Dashboard <span>·</span> Prototype สำหรับพัฒนาและทดสอบระบบ IoT
      </div>
    </div>
  );
}
