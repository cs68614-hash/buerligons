import { allocate, EngineeringModel, SketchFeature } from './engineeringModel'
import { sketchLoops } from './sketchSolver'

export function editRegions(m: EngineeringModel, params: any, creating: boolean): number | boolean {
  let result: number | boolean = true
  for (const input of creating ? [params] : params.regions || []) {
    const s = m.features.find(
      (f): f is SketchFeature =>
        f.type === 'sketch' && (creating ? f.id === input.id : f.regions.some(r => r.id === input.id)),
    )
    if (!s) throw new Error('找不到草图区域。')
    const curves: number[] = input.geomIds
    if (!Array.isArray(curves) || !curves.length || new Set(curves).size !== curves.length)
      throw new Error('区域必须选择闭合轮廓。')
    const loops = sketchLoops(s, curves)
    if (!loops.length || new Set(loops.flatMap(l => l.curves)).size !== curves.length)
      throw new Error('区域不能包含开放曲线、构造线或分支。')
    const existing = creating
      ? s.regions.find(r => r.curves.length === curves.length && r.curves.every(id => curves.includes(id)))
      : s.regions.find(r => r.id === input.id)
    const region = existing || { ...allocate(m), name: input.name || 'Region', curves }
    Object.assign(region, { curves, manual: true, ...(input.name ? { name: input.name } : {}) })
    if (!existing) s.regions.push(region)
    result = region.id
  }
  return result
}
