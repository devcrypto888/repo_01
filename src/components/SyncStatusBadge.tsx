import { useConnectivity } from '../store/connectivity'
import { usePendingCount } from '../react/useLocalRecords'
import { pushOutbox } from '../sync/push'
import { useState } from 'react'
import { CloudOff, CloudUpload, CloudCheck, Loader2 } from 'lucide-react'

/**
 * Header badge: one glance tells the user whether their work is safe on the
 * server. Clicking it forces a push, which people do right before handing
 * the device over.
 */
export function SyncStatusBadge() {
  const quality = useConnectivity((s) => s.quality)
  const pending = usePendingCount()
  const [pushing, setPushing] = useState(false)

  const flush = async () => {
    if (pushing || quality === 'offline') return
    setPushing(true)
    try {
      await pushOutbox()
    } finally {
      setPushing(false)
    }
  }

  const { icon, label, tone } =
    quality === 'offline'
      ? { icon: <CloudOff size={16} />, label: pending ? `Offline · ${pending} waiting` : 'Offline', tone: 'bg-amber-100 text-amber-900' }
      : pushing
        ? { icon: <Loader2 size={16} className="animate-spin" />, label: 'Syncing…', tone: 'bg-sky-100 text-sky-900' }
        : pending
          ? { icon: <CloudUpload size={16} />, label: `${pending} to upload`, tone: 'bg-sky-100 text-sky-900' }
          : { icon: <CloudCheck size={16} />, label: 'All saved', tone: 'bg-emerald-100 text-emerald-900' }

  return (
    <button
      type="button"
      onClick={flush}
      disabled={quality === 'offline' || pushing}
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${tone}`}
    >
      {icon}
      {label}
      {quality === 'degraded' && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-amber-500" title="Weak connection" />}
    </button>
  )
}
