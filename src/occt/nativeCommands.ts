import { CadDocument, emptyDocument, ModelView, rootView, KernelResult } from './model'
import { assemblyCommand } from './assemblyCommands'
import type { MotionDrive } from './assemblySolver'
import { partCommand } from './partCommands'

export type NativeChange = { document?: CadDocument; result: unknown; view?: ModelView; drive?: MotionDrive }
const numeric = (value: unknown, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback
  const n = typeof value === 'number' ? value : Number(String(value).replace(/\s*mm\s*$/, ''))
  if (!Number.isFinite(n)) throw new Error('当前 OCCT 原型只支持数值尺寸（mm）。')
  return n
}
const position = (p: any) =>
  Array.isArray(p)
    ? { x: numeric(p[0]), y: numeric(p[1]), z: numeric(p[2], 0) }
    : { x: numeric(p?.x), y: numeric(p?.y), z: numeric(p?.z, 0) }

/** Native toolbar and editor commands terminate here, never at a ClassCAD server. */
export function nativeCommand(
  name: string,
  p: any,
  current: CadDocument,
  view: ModelView = rootView(),
  geometry?: KernelResult,
): NativeChange {
  const d = structuredClone(current)
  if (Array.isArray(p)) {
    let next = current
    const results = []
    let drive: MotionDrive | undefined
    for (const arg of p) {
      const edit = nativeCommand(name, arg, next, view, geometry)
      if (edit.document) next = edit.document
      drive = edit.drive
      results.push(edit.result)
    }
    return { document: next, result: results, drive }
  }
  if (name === 'v1.common.setObjectName') {
    if (d.kind !== 'assembly' && d.engineering) return partCommand(name, p, d)
    if (d.kind === 'assembly' && d.assembly) {
      const part = d.assembly.parts.find(candidate => candidate.id === p.id)
      const object = d.assembly.instances.find(i => i.id === p.id) || d.assembly.constraints.find(c => c.id === p.id)
      if (part) part.document.name = p.name
      else if (object) object.name = p.name
      else if (p.id === 1) d.name = p.name
      else throw new Error('对象不存在。')
    } else if (p.id === 1) d.name = p.name
    else throw new Error('当前只支持重命名零件、实例和约束。')
    return { document: d, result: true }
  }
  if (name === 'v1.part.openFeature' || name === 'v1.part.closeFeature') return { result: true }
  if (d.kind === 'assembly' && name.startsWith('v1.assembly.') && name !== 'v1.assembly.create')
    return assemblyCommand(name, p, d, view, geometry)
  if (d.kind === 'assembly' && view.productId !== 1 && (name.startsWith('v1.part.') || name.startsWith('v1.sketch.'))) {
    const part = d.assembly?.parts.find(candidate => candidate.id === view.productId)
    if (!part) throw new Error('找不到编辑中的零件。')
    const base = part.id - 1
    const local = { ...p }
    for (const key of ['id', 'planeId', 'axisId', 'originId'])
      if (typeof local[key] === 'number' && local[key] > base && local[key] < base + 10000) local[key] -= base
    if (local.references) local.references = local.references.map((id: number) => id - base)
    for (const key of ['geomIds', 'ids', 'objectIds'])
      if (local[key]) local[key] = local[key].map((id: number) => id - base)
    if (local.target)
      local.target =
        typeof local.target === 'number' ? local.target - base : { ...local.target, id: local.target.id - base }
    if (local.tools)
      local.tools = local.tools.map((t: any) => (typeof t === 'number' ? t - base : { ...t, id: t.id - base }))
    const edit = nativeCommand(name, local, part.document)
    if (edit.document) part.document = edit.document
    const result =
      typeof edit.result === 'number'
        ? edit.result + base
        : Array.isArray(edit.result)
        ? edit.result.map(id => id + base)
        : edit.result
    return { document: edit.document ? d : undefined, result }
  }
  if (
    d.kind === 'assembly' &&
    (name.startsWith('v1.part.') || name.startsWith('v1.sketch.')) &&
    name !== 'v1.part.create'
  )
    throw new Error('请在 Part 文档中创建或编辑草图和拉伸；当前为 Assembly 装配文档。')
  if (
    d.kind !== 'assembly' &&
    (name.startsWith('v1.sketch.') || (name.startsWith('v1.part.') && name !== 'v1.part.create'))
  )
    return partCommand(name, p, d)
  switch (name) {
    case 'v1.common.setDatabaseSettings':
    case 'v1.part.openFeature':
    case 'v1.part.closeFeature':
      return { result: true }
    case 'v1.part.create':
      return { document: { ...emptyDocument(), name: p.name || 'Part' }, result: 1 }
    case 'v1.assembly.create':
      return { document: { ...emptyDocument('assembly'), name: p.name || 'Assembly' }, result: 1 }
    case 'v1.part.sketch':
    case 'v1.sketch.create':
      if (d.sketch || d.rectangle) throw new Error('此 OCCT 原型支持一个矩形草图；请双击现有 Sketch 编辑。')
      if (p.planeId && p.planeId !== 104) throw new Error('当前只支持 XY 平面。')
      d.sketch = { planeId: p.planeId || 0 }
      return { document: d, result: 20 }
    case 'v1.sketch.setWorkPlane':
    case 'v1.sketch.setReferences':
      if (p.planeId !== 104) throw new Error('当前只支持 XY 平面。')
      d.sketch = { planeId: 104 }
      return { document: d, result: true }
    case 'v1.sketch.rectangle': {
      if (!d.sketch || d.sketch.planeId !== 104) throw new Error('请先选择 XY 草图平面。')
      if (d.rectangle) throw new Error('此 OCCT 原型支持一个矩形，请编辑现有矩形尺寸。')
      if (p.isConstruction) throw new Error('当前只支持普通矩形。')
      const a = position(p.startPos),
        b = position(p.endPos)
      const width = Math.abs(b.x - a.x) * (p.isCentered ? 2 : 1),
        height = Math.abs(b.y - a.y) * (p.isCentered ? 2 : 1)
      d.rectangle = {
        x: p.isCentered ? a.x - width / 2 : Math.min(a.x, b.x),
        y: p.isCentered ? a.y - height / 2 : Math.min(a.y, b.y),
        width,
        height,
      }
      return { document: d, result: [400, 401, 402, 403] }
    }
    case 'v1.sketch.updateDimension':
      if (!d.rectangle) throw new Error('没有矩形草图。')
      if (![600, 601, 610, 611].includes(p.id)) throw new Error('未知矩形尺寸。')
      d.rectangle[p.id === 600 || p.id === 610 ? 'width' : 'height'] = numeric(p.value)
      return { document: d, result: true }
    case 'v1.part.createUncommitedObject':
      if (p.type !== 'CC_Extrusion') throw new Error(`OCCT 原型尚未实现 ${p.type}。`)
      if (d.extrusion) throw new Error('请编辑现有 Extrusion。')
      return nativeCommand('v1.part.extrusion', { references: [22], limit2: 20 }, d)
    case 'v1.part.extrusion':
    case 'v1.part.updateExtrusion': {
      if (!d.rectangle) throw new Error('请先绘制矩形草图。')
      if (name.endsWith('.extrusion') && d.extrusion)
        throw new Error('此 OCCT 原型支持一个拉伸；请双击现有 Extrusion 编辑。')
      if (p.type && p.type !== 'UP') throw new Error('当前只支持 Type: Up 拉伸。')
      if (numeric(p.taperAngle, 0) !== 0 || p.capEnds === false) throw new Error('当前只支持无拔模的封闭实体拉伸。')
      if (p.references?.some((id: number) => ![22, 400, 401, 402, 403].includes(id)))
        throw new Error('拉伸只能引用此矩形区域。')
      d.extrusion = { depth: numeric(p.limit2, d.extrusion?.depth ?? 20) }
      return { document: d, result: 30 }
    }
    default:
      if (name.startsWith('v1.assembly.')) throw new Error('请先新建或打开 Assembly 文档。')
      throw new Error(`OCCT 原型暂未实现 ${name}。已接通矩形草图、宽高尺寸和向上拉伸。`)
  }
}
