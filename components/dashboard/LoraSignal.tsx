'use client';

import { useEffect, useMemo, useState } from 'react';
import { RadioTower, Signal, Waves } from 'lucide-react';

import SectionHeader from './SectionHeader';
import { HISTORY_RANGE_OPTIONS, historyRangeMs } from '../../lib/history';
import { fetchSensorHistory } from '../../lib/services/api';

import type {
  HistoryPoint,
  HistoryRange,
  LoraSignal,
} from '../../lib/types/iot';

const REFRESH_MS = 30000;

type Tone = 'good' | 'fair' | 'weak' | 'idle';

/** เกณฑ์คุณภาพลิงก์ LoRa (ค่าปกติของโมดูล SX127x) */
const TONE_LABEL: Record<Tone, string> = {
  good: 'สัญญาณดี',
  fair: 'สัญญาณปานกลาง',
  weak: 'สัญญาณอ่อน',
  idle: 'รอข้อมูล',
};

const TONE_RANK: Record<Tone, number> = {
  idle: 0,
  good: 1,
  fair: 2,
  weak: 3,
};

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rssiTone(rssi: number | null): Tone {
  if (rssi === null) return 'idle';
  if (rssi >= -80) return 'good';
  if (rssi >= -100) return 'fair';

  return 'weak';
}

function snrTone(snr: number | null): Tone {
  if (snr === null) return 'idle';
  if (snr >= 5) return 'good';
  if (snr >= 0) return 'fair';

  return 'weak';
}

/** สถานะรวม = ตัวที่แย่กว่า (สัญญาณแรงแต่ SNR แย่ก็ยังเตือน) */
function worstTone(a: Tone, b: Tone): Tone {
  if (a === 'idle') return b;
  if (b === 'idle') return a;

  return TONE_RANK[a] >= TONE_RANK[b] ? a : b;
}

function statusClass(tone: Tone): string {
  if (tone === 'good') return 'is-normal';
  if (tone === 'idle') return 'is-idle';

  return 'is-warn';
}

function format(value: number | null, digits: number, unit: string): string {
  if (value === null) return '--';

  return `${value.toFixed(digits)} ${unit}`.trim();
}

/** ISO string → เวลาไทย (คืน null ถ้าแปลงไม่ได้ กัน RangeError ตอน format) */
function timeLabel(value: string | null | undefined): string | null {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function axisTime(ts: number, range: HistoryRange): string {
  const date = new Date(ts);

  if (range === '7d') {
    return date.toLocaleDateString('th-TH', {
      day: 'numeric',
      month: 'short',
    });
  }

  return date.toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface MiniChartProps {
  label: string;
  unit: string;
  color: string;
  digits: number;
  series: Array<{ ts: number; value: number }>;
  range: HistoryRange;
}

/** กราฟเส้นเล็ก ๆ สำหรับค่าเดียว (ไม่ต้องมีแกน Y — โชว์ต่ำสุด/สูงสุดในหัวการ์ด) */
function MiniChart({
  label,
  unit,
  color,
  digits,
  series,
  range,
}: MiniChartProps) {
  const bounds = useMemo(() => {
    if (series.length === 0) return { min: 0, max: 1 };

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (const point of series) {
      min = Math.min(min, point.value);
      max = Math.max(max, point.value);
    }

    if (min === max) {
      const pad = Math.abs(min) * 0.1 || 1;

      return { min: min - pad, max: max + pad };
    }

    const pad = (max - min) * 0.12;

    return { min: min - pad, max: max + pad };
  }, [series]);

  const coords = series.map((point, index) => ({
    x: series.length === 1 ? 50 : (index / (series.length - 1)) * 100,
    y: 100 - ((point.value - bounds.min) / (bounds.max - bounds.min)) * 100,
  }));

  const linePath = coords
    .map((coord, index) => `${index === 0 ? 'M' : 'L'} ${coord.x} ${coord.y}`)
    .join(' ');

  const areaPath =
    coords.length > 1
      ? `M ${coords[0].x} 100 ${coords
          .map((coord) => `L ${coord.x} ${coord.y}`)
          .join(' ')} L ${coords[coords.length - 1].x} 100 Z`
      : '';

  const latest = series.length > 0 ? series[series.length - 1].value : null;
  const lowest =
    series.length > 0 ? Math.min(...series.map((item) => item.value)) : null;
  const highest =
    series.length > 0 ? Math.max(...series.map((item) => item.value)) : null;

  const xLabels =
    series.length === 0
      ? []
      : [0, 0.5, 1].map((ratio) => {
          const first = series[0].ts;
          const last = series[series.length - 1].ts;

          return axisTime(first + (last - first) * ratio, range);
        });

  return (
    <article className="lora-chart">
      <div className="lora-chart-head">
        <span>{label}</span>
        <strong style={{ color }}>
          {latest === null ? '--' : latest.toFixed(digits)}
          <em>{unit}</em>
        </strong>
      </div>

      <div className="lora-chart-meta">
        <span>
          ต่ำสุด{' '}
          <b>{lowest === null ? '--' : lowest.toFixed(digits)}</b>
        </span>
        <span>
          สูงสุด{' '}
          <b>{highest === null ? '--' : highest.toFixed(digits)}</b>
        </span>
        <span>
          จุดข้อมูล <b>{series.length}</b>
        </span>
      </div>

      <div className="lora-chart-plot">
        {series.length > 0 ? (
          <svg
            className="lora-chart-svg"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            aria-label={`กราฟ ${label} ย้อนหลัง ${range}`}
          >
            {[0, 33.333, 66.666, 100].map((y) => (
              <line
                key={y}
                x1="0"
                x2="100"
                y1={y}
                y2={y}
                className="chart-grid-line"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {areaPath ? (
              <path d={areaPath} fill={color} fillOpacity="0.12" />
            ) : null}

            {linePath ? (
              <path
                d={linePath}
                fill="none"
                stroke={color}
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
        ) : (
          <div className="lora-chart-empty">
            ยังไม่มีข้อมูลในช่วงนี้
          </div>
        )}

        {series.length === 1 && coords[0] ? (
          <span
            className="chart-single-dot"
            style={{
              left: `${coords[0].x}%`,
              top: `${coords[0].y}%`,
              background: color,
            }}
          />
        ) : null}
      </div>

      <div className="lora-chart-x" aria-hidden="true">
        {xLabels.map((text, index) => (
          <span key={index}>{text}</span>
        ))}
      </div>
    </article>
  );
}

interface LoraSignalSectionProps {
  lora: LoraSignal | null;
}

/**
 * Section E — LoRa Link Monitoring
 * การ์ด RSSI / SNR / Signal Status + กราฟย้อนหลังของลิงก์ LoRa
 */
export default function LoraSignalSection({ lora }: LoraSignalSectionProps) {
  const [range, setRange] = useState<HistoryRange>('24h');
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const data = await fetchSensorHistory('7d');

      if (cancelled) return;

      setPoints(data);
      setLoading(false);
    };

    void load();

    const timer = window.setInterval(() => void load(), REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const rssi = numberOrNull(lora?.rssi);
  const snr = numberOrNull(lora?.snr);

  const rssiLevel = rssiTone(rssi);
  const snrLevel = snrTone(snr);
  const overall = worstTone(rssiLevel, snrLevel);

  const series = useMemo(() => {
    const since = Date.now() - historyRangeMs(range);

    const build = (key: 'rssi' | 'snr') => {
      const list: Array<{ ts: number; value: number }> = [];

      for (const point of points) {
        if (point.ts < since) continue;

        const value = point[key];

        if (typeof value === 'number' && Number.isFinite(value)) {
          list.push({ ts: point.ts, value });
        }
      }

      return list.sort((a, b) => a.ts - b.ts);
    };

    return { rssi: build('rssi'), snr: build('snr') };
  }, [points, range]);

  const updatedLabel = timeLabel(lora?.updatedAt);

  return (
    <section className="dash-section" aria-labelledby="lora-signal">
      <SectionHeader
        eyebrow="Section E · LoRa Link Monitoring"
        title="คุณภาพสัญญาณ LoRa"
        description="ค่าที่รีซีฟเวอร์ Heltec V2 อ่านได้จากแพ็กเก็ต LoRa ล่าสุด (RSSI/SNR) — ใช้ตรวจระยะทางและปัญหาการสื่อสาร"
      >
        <div className="range-group" role="group" aria-label="ช่วงเวลากราฟ LoRa">
          {HISTORY_RANGE_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`range-btn ${range === option.key ? 'is-active' : ''}`}
              aria-pressed={range === option.key}
              onClick={() => setRange(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </SectionHeader>

      <div className="lora-row">
        <article className={`env-card tone-indigo is-${rssiLevel}`}>
          <div className="env-card-top">
            <span className="env-icon">
              <RadioTower size={19} strokeWidth={2} />
            </span>

            <span className={`env-status ${statusClass(rssiLevel)}`}>
              <i />
              {TONE_LABEL[rssiLevel]}
            </span>
          </div>

          <div className="env-card-label">
            <strong>RSSI</strong>
            <span>Signal Strength</span>
          </div>

          <div className="env-value">
            {format(rssi, 0, 'dBm')}
          </div>

          <div className="env-foot">
            <span>ความแรงสัญญาณที่รีซีฟเวอร์รับได้</span>
            <span>เกณฑ์ดี ≥ -80 dBm</span>
          </div>
        </article>

        <article className={`env-card tone-cyan is-${snrLevel}`}>
          <div className="env-card-top">
            <span className="env-icon">
              <Waves size={19} strokeWidth={2} />
            </span>

            <span className={`env-status ${statusClass(snrLevel)}`}>
              <i />
              {TONE_LABEL[snrLevel]}
            </span>
          </div>

          <div className="env-card-label">
            <strong>SNR</strong>
            <span>Signal-to-Noise Ratio</span>
          </div>

          <div className="env-value">{format(snr, 1, 'dB')}</div>

          <div className="env-foot">
            <span>สัญญาณเทียบสัญญาณรบกวน</span>
            <span>เกณฑ์ดี ≥ 5 dB</span>
          </div>
        </article>

        <article className={`env-card tone-green is-${overall}`}>
          <div className="env-card-top">
            <span className="env-icon">
              <Signal size={19} strokeWidth={2} />
            </span>

            <span className="env-status">
              <i />
              {updatedLabel ? `ล่าสุด ${updatedLabel}` : 'ยังไม่ได้รับค่า'}
            </span>
          </div>

          <div className="env-card-label">
            <strong>สถานะสัญญาณ</strong>
            <span>Signal Status</span>
          </div>

          <div className="env-value lora-value-text">
            {TONE_LABEL[overall]}
          </div>

          <div className="env-foot">
            <span>ประเมินจาก RSSI และ SNR ร่วมกัน</span>
            <span>Heltec V2 · LoRa</span>
          </div>
        </article>
      </div>

      <div className="lora-charts">
        <MiniChart
          label="RSSI History"
          unit="dBm"
          color="#6379cc"
          digits={0}
          series={series.rssi}
          range={range}
        />

        <MiniChart
          label="SNR History"
          unit="dB"
          color="#3aa0a8"
          digits={1}
          series={series.snr}
          range={range}
        />
      </div>

      {loading && series.rssi.length === 0 && series.snr.length === 0 ? (
        <p className="env-formula">กำลังโหลดข้อมูลย้อนหลัง…</p>
      ) : null}

      <h2 id="lora-signal" className="sr-only">
        คุณภาพสัญญาณ LoRa
      </h2>
    </section>
  );
}
