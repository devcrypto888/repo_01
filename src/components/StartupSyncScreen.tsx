import { useEffect, useState } from 'react'
import { useStartupProgress, overallPercent, etaSeconds, type Phase } from '../store/startup-progress'
import { CheckCircle2, CircleDashed, Loader2, XCircle } from 'lucide-react'

interface Props {
  onRetryFailed: () => void
  onContinue: () => void
}

/**
 * Full-screen progress for the first sync after login. It can take minutes on
 * a weak connection, so it shows real per-phase numbers and an ETA instead of
 * a spinner, and lets the user continue with partial data if a phase failed.
 */
export function StartupSyncScreen({ onRetryFailed, onContinue }: Props) {
  const { phases, active } = useStartupProgress()
  const percent = overallPercent(phases)
  const running = phases.find((p) => p.status === 'running')
  const failed = phases.filter((p) => p.status === 'failed')

  // Re-render once a second so the ETA counts down smoothly between progress events.
  const [, force] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])

  const eta = etaSeconds(running)

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Preparing offline data</h1>
        <p className="text-sm text-muted-foreground">
          Keep the app open. You can work without a connection once this finishes.
        </p>
      </header>

      <div>
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{percent}%</span>
          {eta !== null && <span>~{formatDuration(eta)} left</span>}
        </div>
      </div>

      <ul className="space-y-2">
        {phases.map((p) => (
          <PhaseRow key={p.id} phase={p} />
        ))}
      </ul>

      {!active && failed.length > 0 && (
        <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm">
          <p>
            {failed.length} step{failed.length > 1 ? 's' : ''} didn't finish. You can retry now or continue with what was
            downloaded. Missing data will sync in the background.
          </p>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={onRetryFailed}>Retry</button>
            <button className="btn-ghost" onClick={onContinue}>Continue anyway</button>
          </div>
        </div>
      )}
    </div>
  )
}

function PhaseRow({ phase }: { phase: Phase }) {
  const icon = {
    pending: <CircleDashed size={16} className="text-muted-foreground" />,
    running: <Loader2 size={16} className="animate-spin text-primary" />,
    done: <CheckCircle2 size={16} className="text-emerald-600" />,
    failed: <XCircle size={16} className="text-red-600" />,
  }[phase.status]

  return (
    <li className="flex items-center gap-2 text-sm">
      {icon}
      <span className="flex-1">{phase.label}</span>
      {phase.total > 0 && (
        <span className="tabular-nums text-xs text-muted-foreground">
          {phase.processed.toLocaleString()} / {phase.total.toLocaleString()}
        </span>
      )}
      {phase.error && <span className="sr-only">Error: {phase.error}</span>}
    </li>
  )
}

function formatDuration(s: number) {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
