import type { CadDocument } from './model'
import { allocate, ensureEngineering } from './engineeringModel'

export function importStepDocument(name: string, step: string): CadDocument {
  const d: CadDocument = {
      format: 'buerligons-occt',
      version: 1,
      units: 'mm',
      name: name.replace(/\.(stp|step)$/i, '') || 'STEP Part',
      kind: 'part',
      rectangle: null,
      extrusion: null,
    },
    m = ensureEngineering(d)
  const f = {
    ...allocate(m),
    type: 'import' as const,
    name: 'STEP Import',
    opId: allocate(m).id,
    bodyId: allocate(m).id,
    step,
  }
  m.features.push(f)
  return d
}
