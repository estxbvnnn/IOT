import { cn } from '@/lib/cn'

/**
 * Tarjeta de cifra (stat tile): etiqueta · valor · detalle · tendencia opcional.
 * Valores con cifras proporcionales (no tabulares) y en la misma sans que todo el sistema.
 */
interface StatProps {
  label: string
  value: React.ReactNode
  unit?: string
  detail?: React.ReactNode
  icon?: React.ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>
  iconClassName?: string
  /** Mini gráfico (sparkline) a la derecha. */
  trend?: React.ReactNode
  className?: string
}

export function Stat({ label, value, unit, detail, icon: Icon, iconClassName, trend, className }: StatProps) {
  return (
    <div className={cn('card flex min-h-[104px] flex-col justify-between gap-2 px-4 py-3.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
        {Icon && <Icon size={16} className={cn('text-ink-3', iconClassName)} aria-hidden />}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1">
            <span className="text-[28px] font-semibold leading-none tracking-tight text-ink">{value}</span>
            {unit && <span className="text-[13px] font-medium text-ink-3">{unit}</span>}
          </div>
          {detail && <div className="mt-1.5 truncate text-[12px] text-ink-3">{detail}</div>}
        </div>
        {trend && <div className="shrink-0">{trend}</div>}
      </div>
    </div>
  )
}
