import { cn } from '@/lib/cn'

interface CardProps {
  title?: React.ReactNode
  description?: React.ReactNode
  /** Controles a la derecha del título (botones, enlaces). */
  action?: React.ReactNode
  children?: React.ReactNode
  className?: string
  /** Sin relleno interno (tablas que llegan al borde). */
  flush?: boolean
  id?: string
  headingLevel?: 2 | 3
}

export function Card({ title, description, action, children, className, flush, id, headingLevel = 2 }: CardProps) {
  const H = headingLevel === 2 ? 'h2' : 'h3'
  return (
    <section id={id} className={cn('card', className)} aria-labelledby={title && id ? `${id}-t` : undefined}>
      {(title || action) && (
        <header className={cn('flex items-start justify-between gap-3', flush ? 'px-[18px] pt-4 pb-3' : 'px-[18px] pt-4')}>
          <div className="min-w-0">
            {title && <H id={id ? `${id}-t` : undefined} className="text-[15px] font-semibold leading-snug text-ink">{title}</H>}
            {description && <p className="mt-0.5 text-[12.5px] text-ink-3">{description}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={cn(flush ? '' : 'px-[18px] pb-[18px]', title || action ? (flush ? '' : 'pt-3') : flush ? '' : 'pt-[18px]')}>{children}</div>
    </section>
  )
}

export function EmptyState({ icon: Icon, title, children }: { icon?: React.ComponentType<{ size?: number; className?: string }>; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {Icon && <Icon size={28} className="text-ink-3" />}
      <p className="text-[14px] font-semibold text-ink">{title}</p>
      {children && <p className="max-w-md text-[13px] text-ink-3">{children}</p>}
    </div>
  )
}
