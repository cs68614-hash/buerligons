import type { CadDocument } from './model'
import {
  allocate,
  ensureEngineering,
  EngineeringModel,
  PartFeature,
  SketchEntity,
  SketchFeature,
  SketchPoint,
  uid,
} from './engineeringModel'
import { entityPoints, getEntity, getPoint, measured, sketchLoops, solveSketch, fixedValues } from './sketchSolver'
import type { NativeChange } from './nativeCommands'
import { numeric as number, position as point } from './partValues'
import { editRegions } from './sketchRegions'
const feature = (m: EngineeringModel, id: number): PartFeature => {
  const f = m.features.find(candidateFeature => candidateFeature.id === id)
  if (!f) throw new Error('特征引用不存在。')
  return f
}
const sketch = (m: EngineeringModel, id: number): SketchFeature => {
  const s = feature(m, id)
  if (s.type !== 'sketch') throw new Error('请选择草图。')
  return s
}
const addPoint = (m: EngineeringModel, s: SketchFeature, pos: number[]): SketchPoint => {
  const p = { ...allocate(m), x: pos[0], y: pos[1] }
  s.points.push(p)
  return p
}
const constrain = (m: EngineeringModel, s: SketchFeature, type: string, entities: number[], name = type) => {
  const c = { ...allocate(m), type, entities, name }
  s.constraints.push(c)
  return c
}
const dimension = (
  m: EngineeringModel,
  s: SketchFeature,
  type: string,
  entities: number[],
  value?: number,
  position?: number[],
  name = type,
) => {
  const c = {
    ...allocate(m),
    type,
    entities,
    name,
    value: value ?? measured(s, type, entities),
    dimensionId: allocate(m).id,
    position,
  }
  s.constraints.push(c)
  return c
}
function addLine(m: EngineeringModel, s: SketchFeature, a: number[], b: number[], construction = false): SketchEntity {
  const existing = [...s.points],
    start = addPoint(m, s, a),
    end = addPoint(m, s, b),
    e: SketchEntity = { ...allocate(m), type: 'line', start: start.id, end: end.id, construction }
  s.entities.push(e)
  for (const p of [start, end]) {
    const match = existing.find(q => Math.hypot(p.x - q.x, p.y - q.y) < 1e-6)
    if (match) constrain(m, s, 'COINCIDENT', [p.id, match.id])
  }
  if (Math.abs(a[1] - b[1]) < 1e-6) constrain(m, s, 'HORIZONTAL', [e.id])
  if (Math.abs(a[0] - b[0]) < 1e-6) constrain(m, s, 'VERTICAL', [e.id])
  return e
}
function refresh(m: EngineeringModel, s: SketchFeature): void {
  solveSketch(s)
  const previous = s.regions
  s.regions = sketchLoops(s).map(
    (loop, i) =>
      previous.find(r => r.curves.length === loop.curves.length && r.curves.every(id => loop.curves.includes(id))) || {
        ...allocate(m),
        name: `Region ${i + 1}`,
        curves: loop.curves,
      },
  )
  s.regions.push(...previous.filter(r => r.manual && !s.regions.some(n => n.id === r.id) && r.curves.every(id => s.entities.some(e => e.id === id))))
}
const bodyFeature = (m: EngineeringModel, p: any): number => {
  const id = typeof p === 'object' ? p?.id : p
  if (p?.indices?.some((n: number) => n !== 0)) throw new Error('当前布尔选择以完整特征实体为单位。')
  const f = m.features.find(
    candidateFeature => candidateFeature.id === id || ('bodyId' in candidateFeature && candidateFeature.bodyId === id),
  )
  if (!f || f.type === 'sketch') throw new Error('请选择有效实体。')
  return f.id
}
export function partCommand(name: string, p: any, d: CadDocument): NativeChange {
  const m = ensureEngineering(d),
    ok = (result: unknown = true): NativeChange => ({ document: d, result })
  if (name === 'v1.sketch.updateSketchRegion' || name === 'v1.sketch.sketchRegion')
    return ok(editRegions(m, p, name === 'v1.sketch.sketchRegion'))
  if (name === 'v1.common.setObjectName') {
    if (p.id === 1) d.name = p.name
    else {
      const object =
        m.features.find(f => f.id === p.id) ||
        m.features
          .filter((f): f is SketchFeature => f.type === 'sketch')
          .flatMap(s => [...s.regions, ...s.constraints])
          .find(o => o.id === p.id)
      if (!object) throw new Error('无法重命名此对象。')
      object.name = p.name
    }
    return ok()
  }
  if (name === 'v1.sketch.create' || name === 'v1.part.sketch') {
    const first = !m.features.length,
      s: SketchFeature = {
        ...(first ? { id: 20, uid: uid() } : allocate(m)),
        type: 'sketch',
        name: p.name || `Sketch ${m.features.filter(f => f.type === 'sketch').length + 1}`,
        opId: first ? 21 : allocate(m).id,
        dimensionSetId: first ? 14 : allocate(m).id,
        planeId: p.planeId || 0,
        points: [],
        entities: [],
        constraints: [],
        regions: [],
        dof: 0,
        residual: 0,
      }
    m.features.push(s)
    return ok(s.id)
  }
  if (name === 'v1.sketch.setReferences' || name === 'v1.sketch.setWorkPlane') {
    const s = sketch(m, p.id)
    if (p.axisId || p.originId || p.invertPlane || p.invertAxis)
      throw new Error('当前支持 XY / YZ / XZ 基准面，尚未接通自定义轴和原点。')
    if (p.planeId !== undefined) {
      if (![104, 105, 106].includes(p.planeId)) throw new Error('请选择 XY / YZ / XZ 基准面。')
      s.planeId = p.planeId
    }
    return ok()
  }
  if (name === 'v1.part.createUncommitedObject') {
    if (p.type === 'CC_Import') {
      const f = {
        ...allocate(m),
        type: 'import' as const,
        name: 'STEP Import',
        opId: allocate(m).id,
        bodyId: allocate(m).id,
        step: '',
        draft: true,
      }
      m.features.push(f)
      return ok(f.id)
    }
    if (p.type === 'CC_Extrusion') {
      const edit = partCommand('v1.part.extrusion', { ...p, type: 'UP', references: undefined, limit2: 20 }, d)
      Object.assign(feature(m, edit.result as number), { draft: true })
      return edit
    }
    if (['CC_BooleanOperation', 'CC_Union', 'CC_Subtraction', 'CC_Intersection'].includes(p.type)) {
      const f = {
        ...allocate(m),
        type: 'boolean' as const,
        name: 'Subtraction',
        opId: allocate(m).id,
        bodyId: allocate(m).id,
        operation: 'SUBTRACTION' as const,
        target: 0,
        tools: [],
        draft: true,
      }
      m.features.push(f)
      return ok(f.id)
    }
    throw new Error(`OCCT 尚未接通 ${p.type}。`)
  }
  if (name === 'v1.part.importFeature' || name === 'v1.part.updateImportFeature') {
    if (!['STP', 'STEP'].includes(p.format) || p.url || p.file) throw new Error('请选择本地 STEP 文件。')
    const source =
      typeof p.data === 'string'
        ? p.encoding === 'base64'
          ? new TextDecoder().decode(Uint8Array.from(atob(p.data), c => c.charCodeAt(0)))
          : p.data
        : new TextDecoder().decode(p.data instanceof ArrayBuffer ? new Uint8Array(p.data) : p.data)
    let f = name.endsWith('updateImportFeature') ? feature(m, p.id) : undefined
    if (f && f.type !== 'import') throw new Error('导入特征类型无效。')
    if (!f) {
      f = {
        ...allocate(m),
        type: 'import',
        name: p.name || 'STEP Import',
        opId: allocate(m).id,
        bodyId: allocate(m).id,
        step: source,
      }
      m.features.push(f)
    }
    Object.assign(f, { step: source, name: p.name || f.name, draft: false })
    return ok(f.id)
  }
  if (name === 'v1.part.extrusion' || name === 'v1.part.updateExtrusion') {
    let f = name.endsWith('updateExtrusion') ? feature(m, p.id) : undefined
    if (f && f.type !== 'extrusion') throw new Error('拉伸特征类型无效。')
    const references: number[] = p.references ?? (f?.type === 'extrusion' ? f.references : [])
    const s = references.length
      ? m.features.find(
          (candidateFeature): candidateFeature is SketchFeature =>
            candidateFeature.type === 'sketch' &&
            references.every(
              id => candidateFeature.entities.some(e => e.id === id) || candidateFeature.regions.some(r => r.id === id),
            ),
        )
      : [...m.features]
          .reverse()
          .find(
            (candidateFeature): candidateFeature is SketchFeature =>
              candidateFeature.type === 'sketch' && candidateFeature.regions.length > 0,
          )
    if (!s) throw new Error('请先完成闭合草图轮廓，再选择其曲线或区域。')
    if (number(p.taperAngle, 0) !== 0 || p.capEnds === false) throw new Error('当前支持无拔模的封闭实体拉伸。')
    const dir = p.type ?? (f?.type === 'extrusion' ? f.direction : 'UP')
    if (!['UP', 'DOWN', 'BOTH'].includes(dir)) throw new Error('当前拉伸支持 Up、Down、Both。')
    if (!f) {
      const first =
        m.features.filter(candidateFeature => candidateFeature.type === 'extrusion').length === 0 && s.id === 20
      f = {
        ...(first ? { id: 30, uid: uid() } : allocate(m)),
        type: 'extrusion',
        name: p.name || 'Extrusion',
        opId: first ? 31 : allocate(m).id,
        bodyId: first ? 1000 : allocate(m).id,
        regionId: first ? 32 : allocate(m).id,
        sketchId: s.id,
        references: [],
        depth: 20,
        direction: 'UP',
      }
      m.features.push(f)
    }
    Object.assign(f, {
      sketchId: s.id,
      references: references.length ? references : s.regions.map(r => r.id),
      depth: number(p.limit2, f.depth),
      direction: dir,
      draft: false,
    })
    return ok(f.id)
  }
  if (name === 'v1.part.boolean' || name === 'v1.part.updateBoolean') {
    let f = name.endsWith('updateBoolean') ? feature(m, p.id) : undefined
    if (f && f.type !== 'boolean') throw new Error('布尔特征类型无效。')
    const operation = p.type || 'SUBTRACTION'
    if (!['SUBTRACTION', 'UNION', 'INTERSECTION'].includes(operation)) throw new Error('布尔类型无效。')
    const target = bodyFeature(m, p.target),
      tools = (p.tools || []).map((v: any) => bodyFeature(m, v))
    if (!tools.length) throw new Error('请选择至少一个工具实体。')
    if (!f) {
      f = {
        ...allocate(m),
        type: 'boolean',
        name: p.name || operation,
        opId: allocate(m).id,
        bodyId: allocate(m).id,
        operation,
        target,
        tools,
        draft: false,
      }
      m.features.push(f)
    }
    Object.assign(f, {
      name: p.name || ({ SUBTRACTION: 'Subtraction', UNION: 'Union', INTERSECTION: 'Intersection' } as any)[operation],
      operation,
      target,
      tools,
      draft: false,
    })
    return ok(f.id)
  }
  if (name === 'v1.part.deleteFeature') {
    const ids = p.ids || [p.id],
      removed = m.features.filter(f => ids.includes(f.id))
    if (!removed.length) throw new Error('找不到要删除的特征。')
    for (const f of m.features.filter(candidateFeature => !ids.includes(candidateFeature.id)))
      if (
        (f.type === 'extrusion' && ids.includes(f.sketchId)) ||
        (f.type === 'boolean' && [f.target, ...f.tools].some(id => ids.includes(id)))
      )
        throw new Error('该特征被后续特征引用，请先删除依赖特征。')
    m.features = m.features.filter(f => !ids.includes(f.id))
    return ok()
  }
  if (name === 'v1.sketch.updateDimension' || name === 'v1.sketch.updateDimensionPosition') {
    const s = m.features.find(
      (f): f is SketchFeature =>
        f.type === 'sketch' &&
        f.constraints.some(
          candidateConstraint => candidateConstraint.id === p.id || candidateConstraint.dimensionId === p.id,
        ),
    )
    if (!s) throw new Error('找不到草图尺寸。')
    const c = s.constraints.find(
      candidateConstraint => candidateConstraint.id === p.id || candidateConstraint.dimensionId === p.id,
    )!
    if (name.endsWith('Position')) c.position = point(p.pos)
    else c.value = number(p.value)
    refresh(m, s)
    return ok()
  }
  if (name.startsWith('v1.sketch.')) {
    const s = sketch(m, p.id)
    if (!s.planeId) throw new Error('请先选择草图平面。')
    let result: unknown = true
    switch (name) {
      case 'v1.sketch.line':
        result = addLine(m, s, point(p.startPos), point(p.endPos), !!p.isConstruction).id
        break
      case 'v1.sketch.point':
        result = addPoint(m, s, point(p.pos)).id
        break
      case 'v1.sketch.circle': {
        const center = addPoint(m, s, point(p.centerPos)),
          e: SketchEntity = {
            ...allocate(m),
            type: 'circle',
            center: center.id,
            radius: number(p.radius),
            construction: !!p.isConstruction,
          }
        s.entities.push(e)
        result = e.id
        if (!e.construction)
          dimension(m, s, 'DIAMETER', [e.id], e.radius! * 2, [center.x + e.radius! + 10, center.y + 10, 0], 'Diameter')
        break
      }
      case 'v1.sketch.arcBy3Points': {
        const a = point(p.startPos),
          b = point(p.midPos),
          c = point(p.endPos),
          q = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
        if (Math.abs(q) < 1e-8) throw new Error('圆弧的三个点不能共线。')
        const norms = [a, b, c].map(
            candidatePoint => candidatePoint[0] * candidatePoint[0] + candidatePoint[1] * candidatePoint[1],
          ),
          center = [
            (norms[0] * (b[1] - c[1]) + norms[1] * (c[1] - a[1]) + norms[2] * (a[1] - b[1])) / q,
            (norms[0] * (c[0] - b[0]) + norms[1] * (a[0] - c[0]) + norms[2] * (b[0] - a[0])) / q,
            0,
          ]
        const existing = [...s.points],
          start = addPoint(m, s, a),
          end = addPoint(m, s, c),
          cp = addPoint(m, s, center),
          e: SketchEntity = {
            ...allocate(m),
            type: 'arc',
            start: start.id,
            end: end.id,
            center: cp.id,
            clockwise: q < 0,
            construction: !!p.isConstruction,
          }
        s.entities.push(e)
        for (const pt of [start, end]) {
          const match = existing.find(v => Math.hypot(pt.x - v.x, pt.y - v.y) < 1e-6)
          if (match) constrain(m, s, 'COINCIDENT', [pt.id, match.id])
        }
        result = e.id
        break
      }
      case 'v1.sketch.rectangle': {
        const a = point(p.startPos),
          b = point(p.endPos),
          w = Math.abs(b[0] - a[0]) * (p.isCentered ? 2 : 1),
          h = Math.abs(b[1] - a[1]) * (p.isCentered ? 2 : 1),
          x = p.isCentered ? a[0] - w / 2 : Math.min(a[0], b[0]),
          y = p.isCentered ? a[1] - h / 2 : Math.min(a[1], b[1])
        if (w < 0.01 || h < 0.01) throw new Error('矩形宽高至少为 0.01 mm。')
        const corners = [
            [x, y, 0],
            [x + w, y, 0],
            [x + w, y + h, 0],
            [x, y + h, 0],
          ],
          lines = corners.map((corner, i) => addLine(m, s, corner, corners[(i + 1) % 4], !!p.isConstruction))
        // Close the last line to the first: auto coincidence above already linked its last endpoint.
        const anchor = getPoint(s, lines[0].start!),
          fix = constrain(m, s, 'FIXATION', [anchor.id], 'Anchor')
        Object.assign(fix, { fixed: [anchor.x, anchor.y] })
        if (!p.isConstruction) {
          dimension(m, s, 'HORIZONTAL_DISTANCE', [lines[0].start!, lines[0].end!], w, [x + w / 2, y - 12, 0], 'Width')
          dimension(
            m,
            s,
            'VERTICAL_DISTANCE',
            [lines[1].start!, lines[1].end!],
            h,
            [x + w + 12, y + h / 2, 0],
            'Height',
          )
        }
        result = lines.map(e => e.id)
        break
      }
      case 'v1.sketch.constraint': {
        const c = constrain(m, s, p.type, p.geomIds, p.name)
        if (p.type === 'FIXATION') Object.assign(c, { fixed: fixedValues(s, p.geomIds) })
        result = c.id
        break
      }
      case 'v1.sketch.dimension': {
        const same = s.constraints.find(
          candidateConstraint =>
            candidateConstraint.dimensionId &&
            candidateConstraint.type === p.type &&
            candidateConstraint.entities.length === p.geomIds.length &&
            candidateConstraint.entities.every(id => p.geomIds.includes(id)),
        )
        const c =
          same ||
          dimension(
            m,
            s,
            p.type,
            p.geomIds,
            p.value === undefined ? undefined : number(p.value),
            p.dimPos ? point(p.dimPos) : undefined,
            p.name,
          )
        if (same && p.value !== undefined) same.value = number(p.value)
        result = c.id
        break
      }
      case 'v1.sketch.moveGeometry': {
        const delta = point(p.translation),
          ids = new Set<number>(p.geomIds.flatMap((id: number) => entityPoints(s, id)))
        s.points
          .filter(candidatePoint => ids.has(candidatePoint.id))
          .forEach(candidatePoint => {
            candidatePoint.x += delta[0]
            candidatePoint.y += delta[1]
          })
        break
      }
      case 'v1.sketch.updateGeometry': {
        for (const input of p.points || []) {
          const q = getPoint(s, input.id),
            v = point(input.pos)
          q.x = v[0]
          q.y = v[1]
        }
        for (const input of [...(p.lines || []), ...(p.circles || [])]) {
          const e = getEntity(s, input.id)
          for (const [key, id] of [
            ['startPos', e.start],
            ['endPos', e.end],
            ['centerPos', e.center],
          ] as const)
            if (input[key]) {
              const q = getPoint(s, id!),
                v = point(input[key])
              q.x = v[0]
              q.y = v[1]
            }
          if (input.radius !== undefined) {
            e.radius = number(input.radius)
            s.constraints.filter(c => ['RADIUS', 'DIAMETER'].includes(c.type) && c.entities[0] === e.id)
              .forEach(c => { c.value = e.radius! * (c.type === 'DIAMETER' ? 2 : 1) })
          }
          if (input.isConstruction !== undefined) e.construction = !!input.isConstruction
        }
        break
      }
      case 'v1.sketch.deleteObject': {
        const ids = p.objectIds || p.ids || [p.objectId],
          entities = s.entities.filter(e => ids.includes(e.id) || entityPoints(s, e.id).some(id => ids.includes(id))),
          removed = new Set([...ids, ...entities.flatMap(e => [e.id, ...entityPoints(s, e.id)])])
        s.entities = s.entities.filter(e => !removed.has(e.id))
        s.points = s.points.filter(candidatePoint => !removed.has(candidatePoint.id))
        s.constraints = s.constraints.filter(
          c => !removed.has(c.id) && !removed.has(c.dimensionId) && !c.entities.some(id => removed.has(id)),
        )
        break
      }
      default:
        throw new Error(`OCCT 尚未接通 ${name}。`)
    }
    refresh(m, s)
    return ok(result)
  }
  if (name === 'v1.part.openFeature' || name === 'v1.part.closeFeature') return { result: true }
  throw new Error(`OCCT 尚未接通 ${name}。`)
}
