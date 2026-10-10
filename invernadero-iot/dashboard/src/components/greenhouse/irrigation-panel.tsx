'use client'

import { Droplets, Info, KeyRound, Loader2, ShieldCheck, Square, Timer, Waves, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  cancelCommandAction, confirmIrrigationAction, requestIrrigationAction, stopPumpAction,
} from '@/app/actions/operations'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { BandChip, PumpChip } from '@/components/ui/status'
import type { GreenhouseSummary } from '@/lib/domain/types'
import { cn } from '@/lib/cn'
import { fmtAgo, fmtDuration } from '@/lib/format'
import type { CommandDTO } from '@/lib/services/commands'
import { CommandStatusChip, commandStatusMeta, commandTypeLabel, isFinalStatus } from './cp-command-status'
import { durationPresets } from './cp-thresholds-fields'
import { CommandTimeline } from './cp-timeline'

/**
 * Riego manual (informe, tabla 11: «toda orden manual exige confirmación en dos pasos y tiene corte
 * automático por temporizador»). El panel solo ORQUESTA: la seguridad real está en el servidor (permiso,
 * alcance por sector, contraseña, vencimientos) y, sobre todo, en el nodo, que es la autoridad final y
 * rechaza la orden si ya riega, si está en espera entre riegos o si el suelo está saturado.
 *
 *   Paso 1  Revisar     → solicita la orden (aún NO actúa sobre la bomba)
 *   Paso 2  Confirmar   → reingreso de la contraseña (vence a los 60 s)
 *   Paso 3  Seguimiento → en cola → entregada al nodo → ejecutada / rechazada
 */

export interface IrrigationPanelProps {
  greenhouse: GreenhouseSummary
  /** El usuario tiene permiso irrigation:command sobre este invernadero. */
  canCommand: boolean
  /** Súper administrador (pruebas): la orden sale sin confirmar con contraseña y sin esperar a que el nodo esté en línea. */
  bypass?: boolean
}

const MIN_S = 5
const POLL_MS = 2000
const CONFIRM_FALLBACK_MS = 60_000

type Phase =
  | { step: 'closed' }
  | { step: 'review' }
  | { step: 'confirm'; cmd: CommandDTO; deadline: number }
  | { step: 'track' }

type Busy = 'request' | 'confirm' | 'cancel' | 'stop' | null

interface Banner { tone: 'info' | 'warn'; text: string }

/**
 * Sigue una orden ya confirmada consultando su estado cada 2 s. Se detiene al llegar a un estado final,
 * al cambiar de orden o al desmontar (AbortController: no quedan peticiones colgadas).
 */
function useCommandTracking(cmd: CommandDTO | null, onUpdate: (c: CommandDTO) => void): string | null {
  const [problem, setProblem] = useState<string | null>(null)
  const id = cmd?.id
  const status = cmd?.status
  const tracking = !!id && !!status && status !== 'awaiting_confirmation' && !isFinalStatus(status)

  useEffect(() => {
    if (!tracking || !id) return
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const tick = async () => {
      try {
        const res = await fetch(`/api/commands/${id}`, { signal: ctrl.signal, cache: 'no-store' })
        if (res.status === 401) {
          setProblem('Tu sesión venció. Vuelve a ingresar para seguir la orden.')
          return
        }
        // 403/404 no se arreglan reintentando: se deja de consultar en vez de sondear para siempre.
        if (res.status === 403 || res.status === 404) {
          setProblem('No se pudo consultar esta orden (ya no existe o no tienes acceso). Revisa «Órdenes recientes».')
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { ok?: boolean; command?: CommandDTO }
        // El efecto ya se limpió (otra orden, cancelada o panel desmontado): una respuesta tardía no debe pisar el estado.
        if (stopped) return
        if (body.ok && body.command) {
          setProblem(null)
          onUpdate(body.command)
          if (isFinalStatus(body.command.status)) return
        }
      } catch {
        if (ctrl.signal.aborted) return
        setProblem('Sin conexión con el servidor; reintentando…')
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => {
      stopped = true
      ctrl.abort()
      if (timer) clearTimeout(timer)
    }
  }, [tracking, id, onUpdate])

  return problem
}

interface Advisory {
  key: string
  icon: React.ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>
  tone: 'info' | 'warn' | 'off'
  text: string
}

const ADV_ICON_TONE: Record<Advisory['tone'], string> = { info: 'text-accent', warn: 'text-warn-ink', off: 'text-ink-3' }

function AdvisoryList({ items, label, className }: { items: Advisory[]; label: string; className?: string }) {
  return (
    <ul className={cn('flex flex-col gap-1.5', className)} aria-label={label}>
      {items.map((a) => {
        const Icon = a.icon
        return (
          <li key={a.key} className="flex items-start gap-2 text-[13px] leading-snug text-ink">
            <Icon size={16} className={cn('mt-px shrink-0', ADV_ICON_TONE[a.tone])} aria-hidden />
            <span>{a.text}</span>
          </li>
        )
      })}
    </ul>
  )
}

export function IrrigationPanel({ greenhouse: g, canCommand, bypass = false }: IrrigationPanelProps) {
  const uid = useId()
  const maxS = g.thresholds.pumpMaxS
  const presets = useMemo(() => durationPresets(maxS), [maxS])

  const [durationText, setDurationText] = useState(() => String(Math.min(20, maxS)))
  const [phase, setPhase] = useState<Phase>({ step: 'closed' })
  const [active, setActive] = useState<CommandDTO | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [banner, setBanner] = useState<Banner | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const primaryRef = useRef<HTMLButtonElement>(null)
  const headingRef = useRef<HTMLParagraphElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  // Solo se actualiza la MISMA orden: una respuesta del sondeo nunca reemplaza a una orden distinta.
  const onTrackUpdate = useCallback((c: CommandDTO) => setActive((cur) => (cur && cur.id === c.id ? c : cur)), [])
  const trackProblem = useCommandTracking(active, onTrackUpdate)

  // --- Duración elegida --------------------------------------------------------------------------
  const durationS = Number(durationText.trim())
  const limitS = maxS
  const durationValid = /^\d+$/.test(durationText.trim()) && durationS >= MIN_S && durationS <= limitS
  const durationError = durationValid ? null : `Ingresa un entero entre ${MIN_S} y ${limitS} s.`

  // --- Estado real de la bomba (del último reporte del nodo) -----------------------------------------
  const ageS = g.ageS ?? 0
  const runningS = g.pumpOn && g.pumpRunS !== null ? g.pumpRunS + ageS : null
  const cooldownLeftS = g.cooldownS !== null && g.cooldownS > 0 ? Math.max(0, g.cooldownS - ageS) : 0
  const nodeUsable = g.hasNode && g.nodeEnabled
  const openOrder = active !== null && !isFinalStatus(active.status)

  const advisories: Advisory[] = []
  if (!nodeUsable) {
    advisories.push({ key: 'nonode', icon: WifiOff, tone: 'off', text: 'Este invernadero no tiene un nodo habilitado.' })
  } else if (!g.online) {
    advisories.push({
      key: 'offline', icon: WifiOff, tone: 'warn',
      text: g.lastSeen ? `El nodo no reporta desde ${fmtAgo(g.ageS)}: una orden no llegaría.` : 'El nodo todavía no ha reportado.',
    })
  }
  if (g.pumpOn) {
    advisories.push({ key: 'on', icon: Droplets, tone: 'info', text: 'La bomba ya está regando: el nodo rechazará una orden nueva. Si hace falta, puedes detenerla.' })
  }
  if (!g.pumpOn && g.pumpState === 'espera') {
    advisories.push({
      key: 'wait', icon: Timer, tone: 'info',
      text: `En espera entre riegos (≈ ${fmtDuration(cooldownLeftS)}): el nodo rechazará una orden hasta que termine.`,
    })
  }
  if (g.band === 'saturado') {
    advisories.push({ key: 'sat', icon: Waves, tone: 'info', text: `Suelo saturado (lectura ${g.soilRaw}): el nodo rechazará el riego.` })
  }
  if (g.pumpState === 'bloq_temp') {
    advisories.push({ key: 'heat', icon: Info, tone: 'info', text: 'El riego AUTOMÁTICO está bloqueado por calor; una orden manual sí puede ejecutarse.' })
  }
  const dialogAdvisories = advisories.filter((a) => a.tone !== 'off')

  let disabledReason: string | null = null
  if (!nodeUsable) disabledReason = 'Este invernadero no tiene un nodo habilitado.'
  else if (!g.online && !bypass) disabledReason = 'El nodo no está reportando: la orden no llegaría.'
  else if (openOrder && !bypass) disabledReason = 'Ya hay una orden en curso para este invernadero.'
  const canStart = canCommand && disabledReason === null && durationValid

  // --- Enfoque al cambiar de paso ----------------------------------------------------------------
  useEffect(() => {
    if (phase.step === 'review') primaryRef.current?.focus()
    else if (phase.step === 'track') headingRef.current?.focus()
  }, [phase.step])

  // Cuenta regresiva del paso 2. Sale del reloj LOCAL (no del del servidor) para no depender de relojes sincronizados.
  useEffect(() => {
    if (phase.step !== 'confirm') return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [phase.step])

  const secondsLeft = phase.step === 'confirm' ? Math.max(0, Math.ceil((phase.deadline - now) / 1000)) : 0
  const confirmExpired = phase.step === 'confirm' && secondsLeft === 0

  // Tras «contraseña incorrecta» el campo estuvo DESHABILITADO mientras corría la petición, y enfocar un campo
  // deshabilitado no hace nada: se enfoca cuando React ya lo volvió a habilitar.
  useEffect(() => {
    if (phase.step === 'confirm' && passwordError && busy === null) passwordRef.current?.focus()
  }, [phase.step, passwordError, busy])

  // --- Acciones --------------------------------------------------------------------------------------
  const openReview = () => {
    setDialogError(null)
    setPasswordError(null)
    setPassword('')
    setBanner(null)
    setPhase({ step: 'review' })
  }

  const onRequest = async () => {
    if (!durationValid || busy) return
    setBusy('request')
    setDialogError(null)
    const sentAt = Date.now()
    const res = await requestIrrigationAction({ greenhouseId: g.id, durationS })
    setBusy(null)
    if (!res.ok) {
      setDialogError(res.error)
      return
    }
    // Súper administrador: la orden ya quedó en cola, no hay paso de confirmación.
    if (res.data.status !== 'awaiting_confirmation') {
      setActive(res.data)
      setPhase({ step: 'track' })
      return
    }
    // La ventana de confirmación se cuenta desde ANTES de enviar: el reloj local nunca promete más tiempo del real.
    const windowMs = res.data.confirmExpiresAt ? Date.parse(res.data.confirmExpiresAt) - Date.parse(res.data.createdAt) : CONFIRM_FALLBACK_MS
    setPassword('')
    setPasswordError(null)
    setNow(Date.now()) // reloj al día desde el primer cuadro del paso 2 (sin un parpadeo con el valor viejo)
    setPhase({ step: 'confirm', cmd: res.data, deadline: sentAt + (Number.isFinite(windowMs) && windowMs > 0 ? windowMs : CONFIRM_FALLBACK_MS) })
  }

  const cancelOrder = async (cmd: CommandDTO): Promise<boolean> => {
    setBusy('cancel')
    const res = await cancelCommandAction(cmd.id)
    setBusy(null)
    if (res.ok) {
      setActive((cur) => (cur && cur.id === cmd.id ? res.data : cur))
      return true
    }
    return false
  }

  const onConfirm = async (e: React.FormEvent) => {
    e.preventDefault()
    if (phase.step !== 'confirm' || busy) return
    if (!password) {
      setPasswordError('Ingresa tu contraseña para confirmar.')
      passwordRef.current?.focus()
      return
    }
    setBusy('confirm')
    setDialogError(null)
    setPasswordError(null)
    const res = await confirmIrrigationAction({ commandId: phase.cmd.id, password })
    setBusy(null)
    setPassword('')
    if (res.ok) {
      setActive(res.data)
      setPhase({ step: 'track' })
      return
    }
    switch (res.code) {
      case 'auth':
        setPasswordError('Contraseña incorrecta. La orden sigue pendiente: inténtalo de nuevo.') // el efecto devuelve el foco al campo
        break
      case 'expired':
      case 'not_found':
      case 'invalid':
        setPhase({ step: 'review' })
        setDialogError(res.code === 'expired' ? 'La confirmación venció. Solicita el riego nuevamente.' : res.error)
        break
      default:
        setDialogError(res.error) // locked, forbidden, …
    }
  }

  /** Cierra el diálogo. A mitad del paso 2 se cancela la orden pendiente: así no bloquea el sector hasta que venza. */
  const requestClose = async () => {
    if (busy) return
    if (phase.step === 'confirm') {
      const ok = await cancelOrder(phase.cmd)
      setPhase({ step: 'closed' })
      setActive(null)
      setBanner({ tone: 'info', text: ok ? 'Orden cancelada: no se envió nada al nodo.' : 'La orden pendiente venció sin confirmarse.' })
      return
    }
    setPhase({ step: 'closed' })
  }

  const backToReview = async () => {
    if (phase.step === 'confirm') await cancelOrder(phase.cmd) // libera la orden vencida
    setActive(null)
    setDialogError(null)
    setPhase({ step: 'review' })
  }

  const onStop = async () => {
    if (busy) return
    setBusy('stop')
    setBanner(null)
    const res = await stopPumpAction(g.id)
    setBusy(null)
    if (res.ok) setActive(res.data)
    else setBanner({ tone: 'warn', text: res.error })
  }

  // --- Vista ------------------------------------------------------------------------------------------
  const title =
    phase.step === 'review' ? `Regar ${g.code}: revisar`
    : phase.step === 'confirm' ? 'Confirmar con tu contraseña'
    : 'Seguimiento de la orden'
  const stepNumber = phase.step === 'review' ? 1 : phase.step === 'confirm' ? 2 : 3
  const liveText = active ? `${commandTypeLabel(active)}: ${commandStatusMeta[active.status].label}` : ''

  return (
    <Card
      id="riego-manual"
      title="Riego manual"
      description={canCommand ? (bypass ? 'Modo pruebas: sin confirmación · el nodo corta la bomba por temporizador' : 'Confirmación en dos pasos · el nodo corta la bomba por temporizador') : 'Solo lectura'}
    >
      <div className="flex flex-col gap-4">
        {/* Estado real */}
        <div className="flex flex-wrap items-center gap-2">
          <PumpChip state={g.pumpState} on={g.pumpOn} />
          <BandChip band={g.band} />
          {runningS !== null && <span className="text-[12.5px] text-ink-2">Regando desde hace ≈ {fmtDuration(runningS)}</span>}
          {g.lastSeen && <span className="text-[12px] text-ink-3">Último reporte del nodo: {fmtAgo(g.ageS)}</span>}
        </div>

        {advisories.length > 0 && <AdvisoryList items={advisories} label="Avisos antes de regar" />}

        {/* Orden en curso (con el diálogo cerrado) */}
        {active && phase.step === 'closed' && (
          <div className="rounded-xl border border-line bg-surface-2 p-3" role="region" aria-label="Orden en curso">
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-ink">{commandTypeLabel(active)}</span>
              <CommandStatusChip status={active.status} />
            </div>
            <CommandTimeline command={active} intervalS={g.thresholds.intervalS} />
            {trackProblem && <p className="mt-2 text-[12.5px] text-ink-2">{trackProblem}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {isFinalStatus(active.status) ? (
                <button type="button" className="btn btn-sm" onClick={() => setActive(null)}>Descartar</button>
              ) : (
                <>
                  {active.type === 'irrigate' && (
                    <button type="button" className="btn btn-sm" onClick={() => setPhase({ step: 'track' })}>Ver seguimiento</button>
                  )}
                  {active.status === 'queued' && canCommand && (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void cancelOrder(active)}>
                      {busy === 'cancel' && <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden />}
                      Cancelar orden
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {banner && (
          <p role="status" className={cn('rounded-lg px-3 py-2 text-[13px] text-ink', banner.tone === 'warn' ? 'bg-warn-wash' : 'bg-accent-wash')}>{banner.text}</p>
        )}

        {canCommand ? (
          <div className="flex flex-col gap-3">
            <fieldset disabled={!nodeUsable || (!bypass && (!g.online || openOrder))} className="min-w-0">
              <legend className="label">Duración del riego</legend>
              <div className="flex flex-wrap items-center gap-2">
                {presets.map((p) => (
                  <label key={p} className="relative">
                    <input
                      type="radio" name={`${uid}-dur`} value={p} className="peer sr-only"
                      checked={durationValid && durationS === p}
                      onChange={() => setDurationText(String(p))}
                    />
                    <span className="inline-flex h-9 min-w-[58px] cursor-pointer items-center justify-center rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2 peer-checked:border-transparent peer-checked:bg-accent-btn peer-checked:text-white peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[color:var(--focus)] peer-disabled:cursor-not-allowed peer-disabled:opacity-50">
                      {p} s
                    </span>
                  </label>
                ))}
                <span className="mx-1 text-[12px] text-ink-3" aria-hidden>o</span>
                <label htmlFor={`${uid}-custom`} className="sr-only">Otra duración en segundos</label>
                <input
                  id={`${uid}-custom`} type="number" inputMode="numeric" min={MIN_S} max={limitS} step={1}
                  className="input w-[78px]" value={durationText} onChange={(e) => setDurationText(e.target.value)}
                  aria-invalid={!durationValid} aria-describedby={`${uid}-dur-hint`}
                />
                <span className="text-[13px] text-ink-2">s</span>
              </div>
              <p id={`${uid}-dur-hint`} className={cn('mt-1.5', durationValid ? 'hint' : 'field-error')}>
                {durationError ?? `Entre ${MIN_S} y ${maxS} s (máximo configurado para ${g.code}). El nodo corta la bomba solo al cumplirse el tiempo.`}
              </p>
            </fieldset>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button" className="btn btn-primary" onClick={openReview} disabled={!canStart}
                aria-describedby={disabledReason ? `${uid}-why` : undefined}
              >
                <Droplets size={16} aria-hidden />
                Regar ahora
              </button>
              {g.pumpOn && (
                <button type="button" className="btn btn-danger" onClick={() => void onStop()} disabled={busy !== null || (openOrder && !bypass)}>
                  {busy === 'stop' ? <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden /> : <Square size={15} aria-hidden />}
                  Detener bomba
                </button>
              )}
            </div>
            {disabledReason && <p id={`${uid}-why`} className="text-[12.5px] text-ink-3">{disabledReason}</p>}
            {g.pumpOn && !openOrder && (
              <p className="text-[12px] text-ink-3">«Detener» es de un solo paso a propósito: apagar la bomba siempre reduce el riesgo. Queda registrado en la bitácora.</p>
            )}
          </div>
        ) : (
          <p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] leading-snug text-ink-2">
            <ShieldCheck size={16} className="mt-px shrink-0 text-ink-3" aria-hidden />
            <span>Tu rol no puede accionar el riego. Lo hacen el operador asignado a este sector y el administrador; tú ves el estado en tiempo real.</span>
          </p>
        )}
      </div>

      <p className="sr-only" role="status" aria-live="polite">{liveText}</p>

      <Dialog open={phase.step !== 'closed'} onClose={() => void requestClose()} title={title} locked={busy !== null} width={480}>
        <p ref={headingRef} tabIndex={-1} className="eyebrow mb-3 outline-none">
          Paso {stepNumber} de 3 · {stepNumber === 1 ? 'Revisar' : stepNumber === 2 ? 'Confirmar' : 'Seguimiento'}
        </p>

        {phase.step === 'review' && (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13.5px]">
              <dt className="text-ink-3">Invernadero</dt>
              <dd className="font-medium text-ink">{g.code}{g.crop ? ` · ${g.crop}` : ''}</dd>
              <dt className="text-ink-3">Duración</dt>
              <dd className="font-medium text-ink">{durationS} s</dd>
              <dt className="text-ink-3">Estado ahora</dt>
              <dd className="flex flex-wrap items-center gap-1.5"><PumpChip state={g.pumpState} on={g.pumpOn} /><BandChip band={g.band} /></dd>
            </dl>
            {dialogAdvisories.length > 0 && (
              <AdvisoryList items={dialogAdvisories} label="Avisos" className="rounded-lg bg-warn-wash px-3 py-2.5" />
            )}
            <p className="text-[13px] leading-snug text-ink-2">
              La orden se entrega al nodo en su próximo reporte y el nodo corta la bomba <strong className="font-semibold text-ink">por sí solo a los {durationS} s</strong>, aunque falle la red o el servidor.
              Si ya riega, está en espera entre riegos o el suelo está saturado, el nodo la rechaza.
            </p>
            {dialogError && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{dialogError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => void requestClose()} disabled={busy !== null}>Cancelar</button>
              <button ref={primaryRef} type="button" className="btn btn-primary" onClick={() => void onRequest()} disabled={busy !== null || !durationValid}>
                {busy === 'request' && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden />}
                Solicitar
              </button>
            </div>
          </div>
        )}

        {phase.step === 'confirm' && (
          <form onSubmit={(e) => void onConfirm(e)} className="flex flex-col gap-4" noValidate>
            <p className="text-[13.5px] leading-snug text-ink-2">
              Vas a regar <strong className="font-semibold text-ink">{g.code}</strong> durante <strong className="font-semibold text-ink">{phase.cmd.durationS} s</strong>.
              Por seguridad, confirma con tu contraseña: así queda constancia de que fuiste tú.
            </p>
            {confirmExpired ? (
              <div className="rounded-lg bg-warn-wash px-3 py-3 text-[13px] text-ink" role="alert">
                La confirmación venció. Por seguridad hay que solicitar el riego de nuevo.
                <div className="mt-2.5 flex gap-2">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void backToReview()}>Solicitar de nuevo</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void requestClose()}>Cerrar</button>
                </div>
              </div>
            ) : (
              <>
                <div>
                  <label htmlFor={`${uid}-pw`} className="label">Contraseña</label>
                  <div className="relative">
                    <KeyRound size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
                    <input
                      ref={passwordRef} id={`${uid}-pw`} name="password" type="password" autoComplete="current-password" autoFocus
                      className="input pl-9" value={password} onChange={(e) => { setPassword(e.target.value); setPasswordError(null) }}
                      aria-invalid={!!passwordError} aria-describedby={`${uid}-pw-msg`} disabled={busy !== null}
                    />
                  </div>
                  <p id={`${uid}-pw-msg`} className={passwordError ? 'field-error' : 'hint'} role={passwordError ? 'alert' : undefined}>
                    {passwordError ?? 'Es la misma contraseña con la que iniciaste sesión.'}
                  </p>
                </div>
                <p className="text-[12.5px] text-ink-3" role="timer" aria-live="off">
                  La solicitud vence en <strong className="font-semibold text-ink">{secondsLeft} s</strong>. Si no confirmas, no se envía nada al nodo.
                </p>
                {dialogError && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{dialogError}</p>}
                <div className="flex flex-wrap justify-between gap-2">
                  <button type="button" className="btn btn-ghost" onClick={() => void requestClose()} disabled={busy !== null}>Cancelar orden</button>
                  <button type="submit" className="btn btn-primary" disabled={busy !== null}>
                    {busy === 'confirm' && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden />}
                    Confirmar y enviar
                  </button>
                </div>
              </>
            )}
          </form>
        )}

        {phase.step === 'track' && active && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13.5px] font-semibold text-ink">{commandTypeLabel(active)} · {g.code}</span>
              <CommandStatusChip status={active.status} />
            </div>
            <CommandTimeline command={active} intervalS={g.thresholds.intervalS} />
            {trackProblem && <p className="text-[12.5px] text-ink-2" role="status">{trackProblem}</p>}
            {isFinalStatus(active.status) && (
              <p className="text-[12.5px] text-ink-3">La orden terminó; ya no se consulta su estado. El detalle queda en «Órdenes recientes» y en la bitácora.</p>
            )}
            <div className="flex flex-wrap justify-between gap-2">
              {active.status === 'queued' ? (
                <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void cancelOrder(active)}>
                  {busy === 'cancel' && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden />}
                  Cancelar orden
                </button>
              ) : <span />}
              <button type="button" className="btn btn-primary" onClick={() => setPhase({ step: 'closed' })}>Cerrar</button>
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  )
}
