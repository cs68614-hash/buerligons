import { validateAssembly } from './assemblyModel'
import { EngineeringModel, validateEngineering } from './engineeringModel'
export type Rectangle = { x: number; y: number; width: number; height: number }
export type CoordinateSystem = number[][]
export type Mate = {
  path: number[]
  csys: number
  flip: 'X' | '-X' | 'Y' | '-Y' | 'Z' | '-Z'
  reorient: '0' | '90' | '180' | '270'
  /** Semantic BRep reference; csys is only a native UI handle. */
  geometry?: { key: string; kind: 'plane' | 'cylinder' }
}
export const constraintTypes = [
  'FastenedOrigin',
  'Fastened',
  'Slider',
  'Revolute',
  'Cylindrical',
  'Planar',
  'Parallel',
  'Spherical',
] as const
export type ConstraintType = (typeof constraintTypes)[number]
export type AssemblyConstraint = {
  id: number
  name: string
  type: ConstraintType
  draft: boolean
  mate1: Mate | null
  mate2: Mate | null
  values: Record<string, number>
  limits: Record<string, { min: number | null; max: number | null } | null>
}
export type AssemblyData = {
  parts: { id: number; document: CadDocument }[]
  instances: { id: number; productId: number; name: string; csys: CoordinateSystem }[]
  constraints: AssemblyConstraint[]
  nextPart: number
  nextInstance: number
  nextConstraint: number
}
export type ModelView = { productId: number; instanceId: number }
export const rootView = (): ModelView => ({ productId: 1, instanceId: 1 })
export const identityCSys = (): CoordinateSystem => [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
export const emptyAssembly = (): AssemblyData => ({
  parts: [],
  instances: [],
  constraints: [],
  nextPart: 1,
  nextInstance: 1,
  nextConstraint: 1,
})
export type CadDocument = {
  format: 'buerligons-occt'
  version: 1 | 2
  units: 'mm'
  name: string
  /** Older version 1 files without kind are parts. */
  kind?: 'part' | 'assembly'
  assembly?: AssemblyData
  sketch?: { planeId: 0 | 104 }
  rectangle: Rectangle | null
  extrusion: { depth: number } | null
  engineering?: EngineeringModel
}

export const emptyDocument = (kind: 'part' | 'assembly' = 'part'): CadDocument => ({
  format: 'buerligons-occt',
  version: 1,
  units: 'mm',
  name: kind === 'assembly' ? 'Assembly' : 'Part',
  kind,
  sketch: undefined,
  rectangle: null,
  extrusion: null,
})

/** Validate the whole feature graph before a file or edit can replace the current model. */
export function validateDocument(value: unknown): CadDocument {
  const d = value as CadDocument
  if (!d || d.format !== 'buerligons-occt' || ![1, 2].includes(d.version) || d.units !== 'mm') {
    throw new Error('请选择版本 1 或 2 的 .occt.json 文件（单位 mm）。')
  }
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 120) throw new Error('模型名称无效。')
  if (d.kind !== undefined && d.kind !== 'part' && d.kind !== 'assembly') throw new Error('文档类型无效。')
  if (d.kind === 'assembly' && (d.sketch || d.rectangle !== null || d.extrusion !== null))
    throw new Error('装配根节点不能包含零件草图或拉伸，请编辑装配中的零件。')
  if (d.kind !== 'assembly' && d.assembly) throw new Error('零件文件不能包含装配数据。')
  if (d.version === 2) {
    if (!d.engineering || d.kind === 'assembly') throw new Error('版本 2 零件必须包含工程特征图。')
    return {
      format: d.format,
      version: 2,
      units: 'mm',
      name: d.name,
      kind: 'part',
      rectangle: null,
      extrusion: null,
      engineering: validateEngineering(d.engineering),
    }
  }
  if (d.engineering) throw new Error('工程特征图需要版本 2 格式。')
  if (d.rectangle !== null) {
    if (!d.rectangle || typeof d.rectangle !== 'object') throw new Error('矩形草图数据无效。')
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      const n = d.rectangle[key]
      if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e6)
        throw new Error('尺寸必须是有限数字，范围不超过 1,000,000 mm。')
    }
    if (d.rectangle.width < 0.01 || d.rectangle.height < 0.01) throw new Error('矩形宽、高必须至少为 0.01 mm。')
  }
  if (d.extrusion !== null) {
    const depth = d.extrusion?.depth
    if (!d.rectangle) throw new Error('拉伸必须引用矩形草图。')
    if (typeof depth !== 'number' || !Number.isFinite(depth) || depth < 0.01 || depth > 1e6)
      throw new Error('拉伸深度必须在 0.01 到 1,000,000 mm 之间。')
  }
  if (d.sketch && d.sketch.planeId !== 0 && d.sketch.planeId !== 104) throw new Error('当前 OCCT 流程只支持 XY 平面。')
  // Normalize rather than keeping arbitrary fields supplied by a file.
  const normalized: CadDocument = {
    format: d.format,
    version: 1,
    units: 'mm',
    name: d.name,
    kind: d.kind ?? 'part',
    sketch: d.sketch ? { planeId: d.sketch.planeId } : d.rectangle ? { planeId: 104 } : undefined,
    rectangle: d.rectangle
      ? { x: d.rectangle.x, y: d.rectangle.y, width: d.rectangle.width, height: d.rectangle.height }
      : null,
    extrusion: d.extrusion ? { depth: d.extrusion.depth } : null,
  }
  if (d.kind === 'assembly' && d.assembly) normalized.assembly = validateAssembly(d.assembly)
  return normalized
}

export const parseDocument = (text: string): CadDocument => validateDocument(JSON.parse(text))
export const serializeDocument = (d: CadDocument): string => JSON.stringify(validateDocument(d), null, 2)

export type AnalyticSurface = { kind: 'plane' | 'cylinder'; frame: CoordinateSystem; radius?: number; height?: number }
export type FaceMate = AnalyticSurface & { key: string; name: string; bodyId: number; graphicId: number }
export type FaceMesh = {
  vertices: number[]
  normals: number[]
  indices: number[]
  normal: number[]
  planar?: boolean
  surface?: AnalyticSurface
  mate?: { key: string; name: string }
}
export type KernelResult = {
  meshes: FaceMesh[]
  lines: number[][]
  min: number[]
  max: number[]
  valid: boolean
  volume: number
  faceCount: number
  edgeCount: number
  parts?: Record<number, KernelResult>
  mateFrames?: Record<number, FaceMate>
  poses?: Record<number, CoordinateSystem>
  bodies?: { id: number; featureId: number; geometry: KernelResult }[]
  referenceBodies?: { id: number; featureId: number; geometry: KernelResult }[]
}

/** Derived world-space analysis; never persisted as design geometry. */
export type InterferenceRegion = {
  id: string
  instanceIds: [number, number]
  names: [string, string]
  volume: number
  geometry: KernelResult
}
export type InterferenceReport = {
  overlaps: InterferenceRegion[]
  errors: { instanceIds: number[]; message: string }[]
  ignoredInstances: { id: number; name: string; reason: string }[]
  totalPairs: number
  checkedPairs: number
  broadPhaseSkipped: number
  volumeTolerance: number
}

/** Derived drag guard state; accepted document and geometry alone enter CAD history. */
export type MotionBlock = {
  fraction: number
  clearance: number
  reason: 'contact' | 'initialOverlap' | 'budget' | 'constraintPath'
  contacts: { instanceIds: [number, number]; names: [string, string]; points: number[][] }[]
}
export type GuardedMoveResult = { document: CadDocument; result: KernelResult; block?: MotionBlock }
