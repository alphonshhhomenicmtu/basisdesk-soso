import type { FeedStatus } from '../types/market';

interface TelemetryBadgeProps {
  status: FeedStatus;
  label?: string;
  compact?: boolean;
}

const STATUS_STYLES: Record<
  FeedStatus,
  { text: string; bg: string; border: string; dot: string; live: boolean; defaultLabel: string }
> = {
  LIVE_WS: {
    text: 'text-emerald-300',
    bg: 'bg-emerald-500/12',
    border: 'border-emerald-500/30',
    dot: 'bg-emerald-400',
    live: true,
    defaultLabel: 'LIVE WS',
  },
  LIVE_REST: {
    text: 'text-emerald-300',
    bg: 'bg-emerald-500/12',
    border: 'border-emerald-500/30',
    dot: 'bg-emerald-400',
    live: true,
    defaultLabel: 'LIVE REST',
  },
  LIVE_RPC: {
    text: 'text-violet-300',
    bg: 'bg-violet-500/12',
    border: 'border-violet-500/30',
    dot: 'bg-violet-400',
    live: true,
    defaultLabel: 'LIVE RPC',
  },
  LIVE_DIRECT: {
    text: 'text-sky-300',
    bg: 'bg-sky-500/12',
    border: 'border-sky-500/30',
    dot: 'bg-sky-400',
    live: true,
    defaultLabel: 'LIVE API',
  },
  SNAPSHOT: {
    text: 'text-amber-300',
    bg: 'bg-amber-500/12',
    border: 'border-amber-500/30',
    dot: 'bg-amber-400',
    live: false,
    defaultLabel: 'SNAPSHOT',
  },
  FALLBACK: {
    text: 'text-rose-300',
    bg: 'bg-rose-500/12',
    border: 'border-rose-500/30',
    dot: 'bg-rose-400',
    live: false,
    defaultLabel: 'FALLBACK',
  },
};

export function TelemetryBadge({ status, label, compact = false }: TelemetryBadgeProps) {
  const cfg = STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-mono font-medium tracking-wide whitespace-nowrap ${cfg.bg} ${cfg.border} ${cfg.text} ${
        compact ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-0.5 text-[11px]'
      }`}
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        {cfg.live && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${cfg.dot}`}
          />
        )}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      </span>
      {label ?? cfg.defaultLabel}
    </span>
  );
}
