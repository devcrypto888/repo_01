import { create } from 'zustand'

export type PhaseId = 'reference' | 'push' | `pull:${string}`
export type PhaseStatus = 'pending' | 'running' | 'done' | 'failed'

export interface Phase {
  id: PhaseId
  label: string
  status: PhaseStatus
  processed: number
  total: number
  error?: string
  startedAt?: number
  finishedAt?: number
}

interface StartupProgressState {
  active: boolean
  phases: Phase[]
  begin(phases: { id: PhaseId; label: string }[]): void
  start(id: PhaseId): void
  update(id: PhaseId, p: { processed: number; total: number }): void
  complete(id: PhaseId): void
  fail(id: PhaseId, error: string): void
  finish(): void
}

const patch = (phases: Phase[], id: PhaseId, fn: (p: Phase) => Phase) => phases.map((p) => (p.id === id ? fn(p) : p))

export const useStartupProgress = create<StartupProgressState>()((set) => ({
  active: false,
  phases: [],

  begin: (defs) =>
    set({
      active: true,
      phases: defs.map((d) => ({ ...d, status: 'pending', processed: 0, total: 0 })),
    }),

  start: (id) => set((s) => ({ phases: patch(s.phases, id, (p) => ({ ...p, status: 'running', startedAt: Date.now(), error: undefined })) })),

  // Progress callbacks can fire hundreds of times a second during a fast pull;
  // skip no-op updates so subscribers don't re-render for nothing.
  update: (id, { processed, total }) =>
    set((s) => {
      const cur = s.phases.find((p) => p.id === id)
      if (!cur || (cur.processed === processed && cur.total === total)) return s
      return { phases: patch(s.phases, id, (p) => ({ ...p, processed, total })) }
    }),

  complete: (id) => set((s) => ({ phases: patch(s.phases, id, (p) => ({ ...p, status: 'done', finishedAt: Date.now() })) })),

  fail: (id, error) => set((s) => ({ phases: patch(s.phases, id, (p) => ({ ...p, status: 'failed', error, finishedAt: Date.now() })) })),

  finish: () => set({ active: false }),
}))

/** Weighted overall percentage: pull phases dominate because they move the most data. */
export function overallPercent(phases: Phase[]) {
  if (!phases.length) return 0
  let weight = 0
  let acc = 0
  for (const p of phases) {
    const w = p.id.startsWith('pull:') ? 4 : 1
    weight += w
    const frac = p.status === 'done' || p.status === 'failed' ? 1 : p.total ? Math.min(1, p.processed / p.total) : 0
    acc += w * frac
  }
  return Math.round((acc / weight) * 100)
}

/** Rough ETA from throughput so far on the currently running phase. */
export function etaSeconds(phase: Phase | undefined, now = Date.now()) {
  if (phase?.startedAt == null || !phase.total || phase.processed < 50) return null
  const elapsed = (now - phase.startedAt) / 1000
  const rate = phase.processed / elapsed
  return rate > 0 ? Math.round((phase.total - phase.processed) / rate) : null
}
