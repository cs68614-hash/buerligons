import type { CadDocument } from './model'
import { solveSketch } from './sketchSolver'

export type Identity = { id: number; uid: string }
export type SketchPoint = Identity & { x: number; y: number }
export type SketchEntity = Identity & {
  type: 'line' | 'circle' | 'arc'
  start?: number
  end?: number
  center?: number
  radius?: number
  clockwise?: boolean
  construction: boolean
}
export type SketchConstraint = Identity & {
  type: string
  entities: number[]
  name: string
  value?: number
  dimensionId?: number
  position?: number[]
  fixed?: number[]
}
export type SketchFeature = Identity & {
  type: 'sketch'
  name: string
  opId: number
  dimensionSetId: number
  planeId: number
  points: SketchPoint[]
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  regions: (Identity & { name: string; curves: number[]; manual?: boolean })[]
  dof: number
  residual: number
}
export type ExtrusionFeature = Identity & {
  type: 'extrusion'
  name: string
  opId: number
  bodyId: number
  regionId: number
  sketchId: number
  references: number[]
  depth: number
  direction: 'UP' | 'DOWN' | 'BOTH'
  draft?: boolean
}
export type BooleanFeature = Identity & {
  type: 'boolean'
  name: string
  opId: number
  bodyId: number
  operation: 'SUBTRACTION' | 'UNION' | 'INTERSECTION'
  target: number
  tools: number[]
  draft: boolean
}
export type ImportFeature = Identity & {
  type: 'import'
  name: string
  opId: number
  bodyId: number
  step: string
  draft?: boolean
}
export type PartFeature = SketchFeature | ExtrusionFeature | BooleanFeature | ImportFeature
export type EngineeringModel = {
  documentId: string
  modelRevision: number
  baseVersionId: string | null
  kernel: 'OCCT-7.4.0p1'
  nextId: number
  features: PartFeature[]
}
export const uid = (): string => {
  if (crypto.randomUUID) return crypto.randomUUID()
  // Internal HTTP deployments may not expose randomUUID outside a secure context.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export const freshEngineering = (): EngineeringModel => ({
  documentId: uid(),
  modelRevision: 0,
  baseVersionId: null,
  kernel: 'OCCT-7.4.0p1',
  nextId: 700,
  features: [],
})
export const allocate = (m: EngineeringModel): Identity => {
  if (m.nextId === 1000) m.nextId++
  if (m.nextId >= 2900) throw new Error('当前零件的编辑对象数量已达上限。')
  return { id: m.nextId++, uid: uid() }
}
export const visibleBodies = (m: EngineeringModel): (ExtrusionFeature | BooleanFeature | ImportFeature)[] => {
  const bodies = new Map<number, ExtrusionFeature | BooleanFeature | ImportFeature>()
  for (const f of m.features) {
    if (f.type === 'extrusion' || (f.type === 'import' && !f.draft)) bodies.set(f.id, f)
    if (f.type === 'boolean' && !f.draft) {
      bodies.delete(f.target)
      f.tools.forEach(id => bodies.delete(id))
      bodies.set(f.id, f)
    }
  }
  return [...bodies.values()]
}

/** A deliberate schema migration; legacy files keep their original UI IDs and design dimensions. */
export function ensureEngineering(d: CadDocument): EngineeringModel {
  if (d.engineering) return d.engineering
  const m = freshEngineering()
  if (d.sketch || d.rectangle) {
    const s: SketchFeature = {
      id: 20,
      uid: uid(),
      type: 'sketch',
      name: 'Sketch',
      opId: 21,
      dimensionSetId: 14,
      planeId: d.sketch?.planeId ?? 104,
      points: [],
      entities: [],
      constraints: [],
      regions: [],
      dof: 0,
      residual: 0,
    }
    if (d.rectangle) {
      const r = d.rectangle,
        corners = [
          [r.x, r.y],
          [r.x + r.width, r.y],
          [r.x + r.width, r.y + r.height],
          [r.x, r.y + r.height],
        ]
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 2; j++)
          s.points.push({ id: 500 + i * 2 + j, uid: uid(), x: corners[(i + j) % 4][0], y: corners[(i + j) % 4][1] })
        s.entities.push({
          id: 400 + i,
          uid: uid(),
          type: 'line',
          start: 500 + i * 2,
          end: 501 + i * 2,
          construction: false,
        })
        s.constraints.push({
          ...allocate(m),
          name: i % 2 ? 'Vertical' : 'Horizontal',
          type: i % 2 ? 'VERTICAL' : 'HORIZONTAL',
          entities: [400 + i],
        })
        s.constraints.push({
          ...allocate(m),
          name: 'Coincident',
          type: 'COINCIDENT',
          entities: [501 + i * 2, 500 + ((i + 1) % 4) * 2],
        })
      }
      s.constraints.push({ ...allocate(m), type: 'FIXATION', name: 'Origin', entities: [500], fixed: [r.x, r.y] })
      s.constraints.push({
        id: 610,
        uid: uid(),
        type: 'HORIZONTAL_DISTANCE',
        name: 'Width',
        entities: [500, 501],
        value: r.width,
        dimensionId: 600,
        position: [r.x + r.width / 2, r.y - 12, 0],
      })
      s.constraints.push({
        id: 611,
        uid: uid(),
        type: 'VERTICAL_DISTANCE',
        name: 'Height',
        entities: [502, 503],
        value: r.height,
        dimensionId: 601,
        position: [r.x + r.width + 12, r.y + r.height / 2, 0],
      })
      s.regions.push({ id: 22, uid: uid(), name: 'Rectangle region', curves: [400, 401, 402, 403] })
    }
    m.features.push(s)
    if (d.extrusion)
      m.features.push({
        id: 30,
        uid: uid(),
        type: 'extrusion',
        name: 'Extrusion',
        opId: 31,
        bodyId: 1000,
        regionId: 32,
        sketchId: 20,
        references: [22],
        depth: d.extrusion.depth,
        direction: 'UP',
      })
  }
  d.version = 2
  d.kind = 'part'
  d.engineering = m
  delete d.sketch
  d.rectangle = null
  d.extrusion = null
  return m
}

export const sketchConstraintTypes = [
  'COINCIDENT',
  'COLINEAR',
  'CONCENTRIC',
  'EQUAL_LENGTH',
  'EQUAL_RADIUS',
  'FIXATION',
  'HORIZONTAL',
  'MIDPOINT',
  'PARALLEL',
  'PERPENDICULAR',
  'TANGENT',
  'VERTICAL',
]
export const sketchDimensionTypes = [
  'HORIZONTAL_DISTANCE',
  'VERTICAL_DISTANCE',
  'OFFSET',
  'RADIUS',
  'DIAMETER',
  'ANGLE',
  'ANGLEOX',
]
const finite = (n: unknown): number => {
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e6)
    throw new Error('工程尺寸必须为有限数字且不超过 1,000,000 mm。')
  return n
}
export function validateEngineering(input: EngineeringModel): EngineeringModel {
  const m = structuredClone(input),
    ids = new Set<number>(),
    uids = new Set<string>()
  const identity = (o: Identity) => {
    if (
      !o ||
      !Number.isInteger(o.id) ||
      o.id < 14 ||
      o.id >= 3000 ||
      ids.has(o.id) ||
      typeof o.uid !== 'string' ||
      !o.uid ||
      uids.has(o.uid)
    )
      throw new Error('工程对象 ID 无效或重复。')
    ids.add(o.id)
    uids.add(o.uid)
  }
  if (
    !m ||
    typeof m.documentId !== 'string' ||
    !m.documentId ||
    !Number.isInteger(m.modelRevision) ||
    m.modelRevision < 0 ||
    (m.baseVersionId !== null && typeof m.baseVersionId !== 'string') ||
    m.kernel !== 'OCCT-7.4.0p1' ||
    !Array.isArray(m.features) ||
    m.features.length > 64 ||
    !Number.isInteger(m.nextId) ||
    m.nextId < 700 ||
    m.nextId > 2900
  )
    throw new Error('工程文档元数据无效。')
  const previous = new Map<number, PartFeature>()
  const reserve = (id: number) => identity({ id, uid: `reserved-${id}` })
  for (const f of m.features) {
    identity(f)
    reserve(f.opId)
    if (typeof f.name !== 'string' || !f.name.trim() || f.name.length > 120) throw new Error('特征名称无效。')
    if (f.type === 'sketch') {
      reserve(f.dimensionSetId)
      if (
        ![0, 104, 105, 106].includes(f.planeId) ||
        !Array.isArray(f.points) ||
        f.points.length > 256 ||
        !Array.isArray(f.entities) ||
        f.entities.length > 128 ||
        !Array.isArray(f.constraints) ||
        f.constraints.length > 256 ||
        !Array.isArray(f.regions)
      )
        throw new Error('草图结构或数量无效。')
      const points = new Set(
          f.points.map(p => {
            identity(p)
            finite(p.x)
            finite(p.y)
            return p.id
          }),
        ),
        geom = new Set(points)
      for (const e of f.entities) {
        identity(e)
        geom.add(e.id)
        if (typeof e.construction !== 'boolean' || !['line', 'circle', 'arc'].includes(e.type))
          throw new Error('草图曲线类型无效。')
        for (const id of e.type === 'line'
          ? [e.start, e.end]
          : e.type === 'circle'
          ? [e.center]
          : [e.start, e.end, e.center])
          if (!points.has(id!)) throw new Error('草图曲线引用了不存在的点。')
        if (e.type === 'circle' && finite(e.radius) < 0.001) throw new Error('圆半径至少为 0.001 mm。')
      }
      for (const c of f.constraints) {
        identity(c)
        if (
          ![...sketchConstraintTypes, ...sketchDimensionTypes].includes(c.type) ||
          !Array.isArray(c.entities) ||
          !c.entities.length ||
          c.entities.some(id => !geom.has(id))
        )
          throw new Error('草图约束类型或引用无效。')
        if (c.dimensionId !== undefined) {
          reserve(c.dimensionId)
          finite(c.value)
        }
        if (c.position) {
          if (c.position.length !== 3) throw new Error('尺寸位置无效。')
          c.position.forEach(finite)
        }
        if (c.fixed) c.fixed.forEach(finite)
      }
      for (const r of f.regions) {
        identity(r)
        if (!r.curves.length || r.curves.some(id => !f.entities.some(e => e.id === id && !e.construction)))
          throw new Error('草图区域引用无效。')
      }
      finite(f.residual)
      finite(f.dof)
      solveSketch(f)
    } else if (f.type === 'extrusion') {
      reserve(f.bodyId)
      reserve(f.regionId)
      const s = previous.get(f.sketchId)
      if (
        !s ||
        s.type !== 'sketch' ||
        !s.planeId ||
        !['UP', 'DOWN', 'BOTH'].includes(f.direction) ||
        finite(f.depth) < 0.01 ||
        !f.references.length ||
        f.references.some(
          id => !s.regions.some(r => r.id === id) && !s.entities.some(e => e.id === id && !e.construction),
        )
      )
        throw new Error(`拉伸 ${f.name} 的草图／区域引用或深度无效。`)
    } else if (f.type === 'boolean') {
      reserve(f.bodyId)
      if (typeof f.draft !== 'boolean' || !['SUBTRACTION', 'UNION', 'INTERSECTION'].includes(f.operation))
        throw new Error('布尔特征无效。')
      if (!f.draft) {
        const live = visibleBodies({ ...m, features: [...previous.values()] })
        if (
          !live.some(b => b.id === f.target) ||
          !f.tools.length ||
          new Set([f.target, ...f.tools]).size !== f.tools.length + 1 ||
          f.tools.some(id => !live.some(b => b.id === id))
        )
          throw new Error('布尔操作需要不同且仍可用的目标和工具实体。')
      }
    } else if (f.type === 'import') {
      reserve(f.bodyId)
      if (
        typeof f.step !== 'string' ||
        f.step.length > 32 * 1024 * 1024 ||
        (!f.draft && !f.step.trimStart().startsWith('ISO-10303-21;'))
      )
        throw new Error('STEP 源文件无效或超过 32 MB。')
    } else throw new Error('未知工程特征类型。')
    previous.set(f.id, f)
  }
  if ([...ids].some(id => id >= 700 && id >= m.nextId && id !== 1000)) throw new Error('工程 ID 分配计数器无效。')
  return m
}

export function defaultBooleanTarget(m: EngineeringModel): { target: number; tools: number[] } {
  const bodies = visibleBodies(m)
  return { target: bodies[0]?.bodyId || 0, tools: bodies.slice(1).map(f => f.bodyId) }
}
