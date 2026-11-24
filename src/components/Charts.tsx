import type { FanChartPoint, HistogramBin } from '../engine/quant';
import type { EtfDailyFlow, OrderBookSnapshot } from '../types/market';
import { formatCompactUsd, formatPrice, formatSignedCompactUsd } from '../utils/format';

export function EtfFlowBarChart({ data }: { data: EtfDailyFlow[] }) {
  const ordered = [...data].reverse();
  if (!ordered.length) {
    return (
      <div className="flex h-44 items-center justify-center text-xs text-slate-500">
        No ETF flow records loaded.
      </div>
    );
  }

  const W = 520;
  const H = 176;
  const padL = 44;
  const padR = 12;
  const padT = 16;
  const padB = 26;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const maxAbs = Math.max(
    10_000_000,
    ...ordered.map((d) => Math.abs(Number(d.total_net_inflow || 0))),
  );
  const zeroY = padT + chartH * 0.56;
  const upScale = (zeroY - padT) / maxAbs;
  const downScale = (padT + chartH - zeroY) / maxAbs;
  const slotW = chartW / ordered.length;
  const barW = Math.max(12, Math.min(30, slotW * 0.62));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full select-none overflow-visible">
      {/* Horizontal guide lines */}
      {[1, 0.5, 0, -0.5].map((frac) => {
        const y = frac >= 0 ? zeroY - frac * (zeroY - padT) : zeroY + Math.abs(frac) * (padT + chartH - zeroY);
        const val = frac * maxAbs;
        return (
          <g key={frac}>
            <line
              x1={padL}
              y1={y}
              x2={W - padR}
              y2={y}
              stroke={frac === 0 ? 'rgba(148,163,184,0.35)' : 'rgba(148,163,184,0.1)'}
              strokeDasharray={frac === 0 ? undefined : '3 3'}
            />
            <text
              x={padL - 6}
              y={y + 3}
              textAnchor="end"
              className="fill-slate-500 font-mono text-[9px]"
            >
              {frac === 0 ? '$0' : formatCompactUsd(val)}
            </text>
          </g>
        );
      })}

      {/* Daily flow bars */}
      {ordered.map((d, idx) => {
        const flow = Number(d.total_net_inflow || 0);
        const isPos = flow >= 0;
        const h = Math.max(2, Math.abs(flow) * (isPos ? upScale : downScale));
        const x = padL + idx * slotW + (slotW - barW) / 2;
        const y = isPos ? zeroY - h : zeroY;
        const dateLabel = d.date.slice(5);
        return (
          <g key={d.date}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={h}
              rx={2.5}
              fill={isPos ? '#10B981' : '#F43F5E'}
              fillOpacity={0.85}
            >
              <title>{`${d.date}: ${formatSignedCompactUsd(flow)} net flow`}</title>
            </rect>
            {(idx % 2 === 0 || idx === ordered.length - 1) && (
              <text
                x={x + barW / 2}
                y={H - 6}
                textAnchor="middle"
                className="fill-slate-500 font-mono text-[9px]"
              >
                {dateLabel}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function OrderBookDepthChart({ book }: { book: OrderBookSnapshot | undefined }) {
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  if (!bids.length || !asks.length) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-slate-500">
        Awaiting live L2 orderbook snapshot...
      </div>
    );
  }

  const bidCum: Array<{ price: number; cumUsd: number }> = [];
  let runningBid = 0;
  for (const [p, q] of bids.slice(0, 12)) {
    const px = Number(p);
    runningBid += px * Number(q);
    bidCum.push({ price: px, cumUsd: runningBid });
  }
  bidCum.reverse();

  const askCum: Array<{ price: number; cumUsd: number }> = [];
  let runningAsk = 0;
  for (const [p, q] of asks.slice(0, 12)) {
    const px = Number(p);
    runningAsk += px * Number(q);
    askCum.push({ price: px, cumUsd: runningAsk });
  }

  const minPx = bidCum[0].price;
  const maxPx = askCum[askCum.length - 1].price;
  const spanPx = Math.max(1e-8, maxPx - minPx);
  const maxCum = Math.max(1, runningBid, runningAsk);

  const W = 520;
  const H = 190;
  const padL = 48;
  const padR = 14;
  const padT = 16;
  const padB = 26;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const toX = (px: number) => padL + ((px - minPx) / spanPx) * chartW;
  const toY = (cum: number) => padT + chartH - (cum / maxCum) * chartH;

  const bidLine = bidCum.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${toX(pt.price).toFixed(1)} ${toY(pt.cumUsd).toFixed(1)}`).join(' ');
  const bidArea = `${bidLine} L ${toX(bidCum[bidCum.length - 1].price).toFixed(1)} ${padT + chartH} L ${toX(bidCum[0].price).toFixed(1)} ${padT + chartH} Z`;

  const askLine = askCum.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${toX(pt.price).toFixed(1)} ${toY(pt.cumUsd).toFixed(1)}`).join(' ');
  const askArea = `${askLine} L ${toX(askCum[askCum.length - 1].price).toFixed(1)} ${padT + chartH} L ${toX(askCum[0].price).toFixed(1)} ${padT + chartH} Z`;

  const midPx = (bidCum[bidCum.length - 1].price + askCum[0].price) / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full select-none">
      <defs>
        <linearGradient id="bidDepthGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#10B981" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#10B981" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="askDepthGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F43F5E" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#F43F5E" stopOpacity="0.04" />
        </linearGradient>
      </defs>

      {[0.25, 0.5, 0.75, 1].map((frac) => {
        const y = padT + chartH * (1 - frac);
        return (
          <g key={frac}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="rgba(148,163,184,0.1)" strokeDasharray="3 3" />
            <text x={padL - 6} y={y + 3} textAnchor="end" className="fill-slate-500 font-mono text-[9px]">
              {formatCompactUsd(maxCum * frac)}
            </text>
          </g>
        );
      })}

      <path d={bidArea} fill="url(#bidDepthGrad)" />
      <path d={bidLine} fill="none" stroke="#10B981" strokeWidth="2" />

      <path d={askArea} fill="url(#askDepthGrad)" />
      <path d={askLine} fill="none" stroke="#F43F5E" strokeWidth="2" />

      <line
        x1={toX(midPx)}
        y1={padT}
        x2={toX(midPx)}
        y2={padT + chartH}
        stroke="#38BDF8"
        strokeWidth="1"
        strokeDasharray="3 3"
      />

      <text x={padL} y={H - 6} textAnchor="start" className="fill-slate-500 font-mono text-[9px]">
        ${formatPrice(minPx)}
      </text>
      <text x={toX(midPx)} y={H - 6} textAnchor="middle" className="fill-sky-400 font-mono text-[9px] font-semibold">
        Mid ${formatPrice(midPx)}
      </text>
      <text x={W - padR} y={H - 6} textAnchor="end" className="fill-slate-500 font-mono text-[9px]">
        ${formatPrice(maxPx)}
      </text>
    </svg>
  );
}

export function MonteCarloFanChart({
  data,
  initialCapitalUsd,
}: {
  data: FanChartPoint[];
  initialCapitalUsd: number;
}) {
  if (!data.length) return null;

  const W = 620;
  const H = 250;
  const padL = 58;
  const padR = 18;
  const padT = 18;
  const padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const allVals = data.flatMap((d) => [d.p5, d.p95]);
  const rawMin = Math.min(initialCapitalUsd * 0.94, ...allVals);
  const rawMax = Math.max(initialCapitalUsd * 1.03, ...allVals);
  const span = Math.max(100, rawMax - rawMin);
  const yMin = rawMin - span * 0.06;
  const yMax = rawMax + span * 0.06;

  const toX = (i: number) => padL + (i / Math.max(1, data.length - 1)) * chartW;
  const toY = (v: number) => padT + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

  const outerPolygon = [
    ...data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(d.p95).toFixed(1)}`),
    ...[...data]
      .reverse()
      .map((d, revI) => {
        const idx = data.length - 1 - revI;
        return `L ${toX(idx).toFixed(1)} ${toY(d.p5).toFixed(1)}`;
      }),
    'Z',
  ].join(' ');

  const innerPolygon = [
    ...data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(d.p75).toFixed(1)}`),
    ...[...data]
      .reverse()
      .map((d, revI) => {
        const idx = data.length - 1 - revI;
        return `L ${toX(idx).toFixed(1)} ${toY(d.p25).toFixed(1)}`;
      }),
    'Z',
  ].join(' ');

  const medianLine = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(d.p50).toFixed(1)}`)
    .join(' ');
  const p5Line = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(d.p5).toFixed(1)}`)
    .join(' ');

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));
  const stepSkip = Math.max(1, Math.floor(data.length / 6));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-64 w-full select-none">
      {yTicks.map((val, idx) => {
        const y = toY(val);
        return (
          <g key={idx}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="rgba(148,163,184,0.1)" strokeDasharray="3 3" />
            <text x={padL - 8} y={y + 3} textAnchor="end" className="fill-slate-400 font-mono text-[9.5px]">
              {formatCompactUsd(val)}
            </text>
          </g>
        );
      })}

      {/* Initial Capital Reference Line */}
      <line
        x1={padL}
        y1={toY(initialCapitalUsd)}
        x2={W - padR}
        y2={toY(initialCapitalUsd)}
        stroke="rgba(148,163,184,0.45)"
        strokeDasharray="4 4"
      />

      {/* P5-P95 outer band */}
      <path d={outerPolygon} fill="#38BDF8" fillOpacity="0.12" />
      {/* P25-P75 interquartile band */}
      <path d={innerPolygon} fill="#38BDF8" fillOpacity="0.24" />
      {/* P5 tail boundary */}
      <path d={p5Line} fill="none" stroke="#F43F5E" strokeWidth="1.5" strokeDasharray="3 3" />
      {/* P50 median curve */}
      <path d={medianLine} fill="none" stroke="#38BDF8" strokeWidth="2.4" />

      {/* X labels */}
      {data.map((d, i) =>
        i % stepSkip === 0 || i === data.length - 1 ? (
          <text
            key={d.day}
            x={toX(i)}
            y={H - 8}
            textAnchor="middle"
            className="fill-slate-500 font-mono text-[9.5px]"
          >
            {d.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

export function ReturnHistogramChart({
  bins,
  var95Pct,
}: {
  bins: HistogramBin[];
  var95Pct: number;
}) {
  if (!bins.length) return null;

  const W = 440;
  const H = 200;
  const padL = 34;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const maxCount = Math.max(1, ...bins.map((b) => b.count));
  const slotW = chartW / bins.length;
  const barW = Math.max(8, slotW - 4);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-52 w-full select-none">
      {[0.25, 0.5, 0.75, 1].map((frac) => {
        const y = padT + chartH * (1 - frac);
        return (
          <g key={frac}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="rgba(148,163,184,0.1)" strokeDasharray="3 3" />
            <text x={padL - 5} y={y + 3} textAnchor="end" className="fill-slate-500 font-mono text-[9px]">
              {Math.round(maxCount * frac)}
            </text>
          </g>
        );
      })}

      {bins.map((b, idx) => {
        const h = (b.count / maxCount) * chartH;
        const x = padL + idx * slotW + (slotW - barW) / 2;
        const y = padT + chartH - h;
        const midPct = (b.fromPct + b.toPct) / 2;
        const inTail = midPct <= -var95Pct;
        const fill = inTail ? '#F43F5E' : b.isLoss ? '#F59E0B' : '#10B981';
        return (
          <g key={idx}>
            <rect x={x} y={y} width={barW} height={Math.max(1, h)} rx={2} fill={fill} fillOpacity={0.86}>
              <title>{`${b.fromPct.toFixed(1)}% to ${b.toPct.toFixed(1)}%: ${b.count} paths`}</title>
            </rect>
            {(idx % 4 === 0 || idx === bins.length - 1) && (
              <text
                x={x + barW / 2}
                y={H - 7}
                textAnchor="middle"
                className="fill-slate-500 font-mono text-[8.5px]"
              >
                {b.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
