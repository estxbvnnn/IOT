'use client'

import { Loader2, RotateCcw, Save, Undo2 } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { updateThresholdsAction } from '@/app/actions/operations'
import { Card } from '@/components/ui/card'
import type { ThresholdsDTO } from '@/lib/domain/types'
import { cn } from '@/lib/cn'
import { fmtDateTime, fmtDuration, fmtNum } from '@/lib/format'
import { SoilPreview } from './cp-soil-preview'
import {
  DEFAULT_THRESHOLDS, FIELD_SPECS, GROUPS, THRESHOLD_KEYS, type ThresholdErrors, type ThresholdKey, type ThresholdValues,
  changedFields, parseField, toFormText, validateForm,
} from './cp-thresholds-fields'

/**
 * Umbrales de riego y alertas del invernadero (informe, tabla 11: el agrónomo «ajusta umbrales de humedad y
 * temperatura»). Se validan en el navegador para dar mensajes claros, pero la autoridad es el servidor, que
 * repite las mismas reglas; el nodo, además, aplica sus propios límites duros aunque el servidor se equivoque.
 */

export interface ThresholdsPanelProps {
  greenhouseId: number
  greenhouseCode: string
  thresholds: ThresholdsDTO
  /** El usuario tiene permiso thresholds:edit. */
  canEdit: boolean
}

const valuesOf = (t: ThresholdsDTO): ThresholdValues => ({
  soilOn: t.soilOn, soilOff: t.soilOff, soilSat: t.soilSat, tempMax: t.tempMax, tempHeat: t.tempHeat, tempCold: t.tempCold,
  tempFrost: t.tempFrost, humAirMin: t.humAirMin, humAirMax: t.humAirMax, pumpMaxS: t.pumpMaxS, pumpWaitS: t.pumpWaitS,
  intervalS: t.intervalS,
})

const showValue = (key: ThresholdKey, v: number): string => {
  const u = FIELD_SPECS[key].unit
  if (key === 'pumpWaitS' || key === 'intervalS') return `${v} s (${fmtDuration(v)})`
  return u === '/1023' ? `${v} de 1023` : `${fmtNum(v, FIELD_SPECS[key].int ? 0 : 1)} ${u}`
}

export function ThresholdsPanel({ greenhouseId, greenhouseCode, thresholds, canEdit }: ThresholdsPanelProps) {
  const uid = useId()
  const [base, setBase] = useState<ThresholdsDTO>(thresholds)
  const baseValues = useMemo(() => valuesOf(base), [base])
  const [text, setText] = useState<Record<ThresholdKey, string>>(() => toFormText(valuesOf(thresholds)))
  const [errors, setErrors] = useState<ThresholdErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [staleVersion, setStaleVersion] = useState<number | null>(null)

  const baseText = useMemo(() => toFormText(baseValues), [baseValues])
  const dirty = THRESHOLD_KEYS.some((k) => text[k].trim() !== baseText[k])

  // Si el servidor entrega una versión más nueva: se adopta sola, salvo que haya cambios sin guardar.
  useEffect(() => {
    if (thresholds.version === base.version) return
    if (dirty) setStaleVersion(thresholds.version)
    else {
      setBase(thresholds)
      setText(toFormText(valuesOf(thresholds)))
      setStaleVersion(null)
    }
    // Solo reacciona a la versión que llega del servidor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thresholds.version])

  // Valores vigentes en el formulario (los inválidos caen a los guardados) para la vista previa.
  const live = useMemo(() => {
    const out = { ...baseValues }
    for (const k of THRESHOLD_KEYS) {
      const r = parseField(k, text[k])
      if ('value' in r) out[k] = r.value
    }
    return out
  }, [text, baseValues])

  const setField = (k: ThresholdKey, v: string) => {
    setText((t) => ({ ...t, [k]: v }))
    setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e))
    setMessage(null)
    setFormError(null)
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setMessage(null)
    setFormError(null)
    const r = validateForm(text)
    if (!r.values) {
      setErrors(r.errors)
      const first = THRESHOLD_KEYS.find((k) => r.errors[k])
      if (first) document.getElementById(`${uid}-${first}`)?.focus()
      return
    }
    const patch = changedFields(r.values, baseValues)
    if (Object.keys(patch).length === 0) {
      // Solo cambió el formato (p. ej. «35.0» en vez de «35»): no hay nada que enviar; se normaliza el texto.
      setText(toFormText(r.values))
      setErrors({})
      setMessage('No hay cambios que guardar: los valores son los mismos que ya están configurados.')
      return
    }
    setBusy(true)
    const res = await updateThresholdsAction(greenhouseId, patch)
    setBusy(false)
    if (res.ok) {
      setBase(res.data)
      setText(toFormText(valuesOf(res.data)))
      setErrors({})
      setStaleVersion(null)
      setMessage(`Guardado. Versión ${res.data.version}; el nodo la recibe en su próximo reporte.`)
      return
    }
    const fe: ThresholdErrors = {}
    for (const [k, v] of Object.entries(res.fieldErrors ?? {})) if ((THRESHOLD_KEYS as readonly string[]).includes(k)) fe[k as ThresholdKey] = v
    setErrors(fe)
    setFormError(res.error)
  }

  const description = `Versión ${base.version} · actualizado ${fmtDateTime(base.updatedAt)}`

  if (!canEdit) {
    return (
      <Card id="umbrales" title="Umbrales" description={description}>
        <div className="flex flex-col gap-4">
          <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] leading-snug text-ink-2">
            Solo lectura: los umbrales de {greenhouseCode} los ajusta el ingeniero agrónomo o el administrador.
          </p>
          {GROUPS.map((g) => (
            <section key={g.id} aria-labelledby={`${uid}-ro-${g.id}`}>
              <h3 id={`${uid}-ro-${g.id}`} className="eyebrow mb-1.5">{g.title}</h3>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[13px]">
                {g.keys.map((k) => (
                  <div key={k} className="contents">
                    <dt className="text-ink-2">{FIELD_SPECS[k].label}</dt>
                    <dd className="text-right font-medium text-ink">{showValue(k, baseValues[k])}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <SoilPreview sat={baseValues.soilSat} off={baseValues.soilOff} on={baseValues.soilOn} />
        </div>
      </Card>
    )
  }

  return (
    <Card id="umbrales" title="Umbrales" description={description}>
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-5" noValidate>
        {GROUPS.map((g) => (
          <fieldset key={g.id} className="min-w-0 rounded-xl border border-line p-3.5" disabled={busy}>
            <legend className="px-1.5 text-[13px] font-semibold text-ink">{g.title}</legend>
            {g.description && <p className="mb-3 text-[12px] text-ink-3">{g.description}</p>}
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {g.keys.map((k) => {
                const spec = FIELD_SPECS[k]
                const id = `${uid}-${k}`
                const err = errors[k]
                return (
                  <div key={k}>
                    <label htmlFor={id} className="label">{spec.label}</label>
                    <div className="flex items-center gap-2">
                      <input
                        id={id} name={k} type="text" inputMode={spec.int ? 'numeric' : 'decimal'} autoComplete="off"
                        className="input" value={text[k]} onChange={(e) => setField(k, e.target.value)}
                        aria-invalid={!!err} aria-describedby={`${id}-msg`}
                      />
                      <span className="w-9 shrink-0 text-[12.5px] text-ink-3">{spec.unit === '/1023' ? '/1023' : spec.unit}</span>
                    </div>
                    <p id={`${id}-msg`} className={err ? 'field-error' : 'hint'} role={err ? 'alert' : undefined}>
                      {err ?? spec.hint ?? ' '}
                    </p>
                  </div>
                )
              })}
            </div>
            {g.id === 'riego' && (
              <div className="mt-4">
                <SoilPreview sat={live.soilSat} off={live.soilOff} on={live.soilOn} />
              </div>
            )}
          </fieldset>
        ))}

        {staleVersion !== null && (
          <p role="status" className="rounded-lg bg-warn-wash px-3 py-2 text-[13px] text-ink">
            Otra persona actualizó los umbrales (versión {staleVersion}). Descarta tus cambios para ver los nuevos valores.
          </p>
        )}
        {formError && <p role="alert" className="rounded-lg bg-crit-wash px-3 py-2 text-[13px] text-ink">{formError}</p>}
        {message && <p role="status" className="rounded-lg bg-good-wash px-3 py-2 text-[13px] text-ink">{message}</p>}

        <div className={cn('flex flex-wrap items-center gap-2')}>
          <button type="submit" className="btn btn-primary" disabled={!dirty || busy}>
            {busy ? <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden /> : <Save size={16} aria-hidden />}
            Guardar cambios
          </button>
          <button
            type="button" className="btn btn-ghost" disabled={!dirty || busy}
            onClick={() => {
              // Si mientras editabas llegó una versión más nueva del servidor, «descartar» adopta esos valores nuevos.
              const latest = thresholds.version > base.version ? thresholds : base
              setBase(latest)
              setText(toFormText(valuesOf(latest)))
              setErrors({})
              setFormError(null)
              setMessage(null)
              setStaleVersion(null)
            }}
          >
            <Undo2 size={16} aria-hidden />
            Descartar cambios
          </button>
          <button
            type="button" className="btn btn-ghost" disabled={busy}
            onClick={() => { setText(toFormText(DEFAULT_THRESHOLDS)); setErrors({}); setFormError(null); setMessage(null) }}
            title="700 / 500 / 300 de la tabla de la clase; 40 °C, 30 s y 300 s del informe. Solo rellena el formulario: hay que guardar."
          >
            <RotateCcw size={16} aria-hidden />
            Restablecer por defecto
          </button>
        </div>
        <p className="text-[12px] text-ink-3">
          Los cambios viajan al nodo en su próximo reporte. El nodo aplica además sus propios límites duros (riego máximo 5–120 s, espera ≥ 60 s), sin importar lo que se configure aquí.
        </p>
      </form>
    </Card>
  )
}
