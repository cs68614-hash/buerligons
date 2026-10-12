import { AssemblyData, constraintTypes, CoordinateSystem, Mate, validateDocument } from './model'

export const finite = (value: unknown, angle = false): number => {
  let result: number
  if (typeof value === 'number') result = value
  else if (typeof value === 'string' && /^[-+]?\d*\.?\d+(?:e[-+]?\d+)?\s*(?:mm|deg|rad)?$/i.test(value.trim())) {
    result = Number(value.trim().replace(/\s*(mm|deg|rad)$/i, ''))
    if (/deg$/i.test(value.trim())) {
      if (!angle) throw new Error('长度不能使用角度单位。')
      result *= Math.PI / 180
    } else if (!angle && /rad$/i.test(value.trim())) throw new Error('长度不能使用角度单位。')
    else if (angle && /mm$/i.test(value.trim())) throw new Error('角度不能使用长度单位。')
  } else throw new Error('参数必须是有限数值；长度使用 mm，角度使用 rad 或 deg。')
  if (!Number.isFinite(result) || Math.abs(result) > 1e6) throw new Error('参数超出有效范围。')
  return result
}
const label = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new Error('名称无效。')
  return value
}
const id = (n: unknown): number => {
  if (!Number.isSafeInteger(n) || (n as number) <= 0 || (n as number) > 3e6) throw new Error('装配对象 ID 无效。')
  return n as number
}
export function validateCSys(value: unknown): CoordinateSystem {
  if (!Array.isArray(value) || value.length !== 4 || value.some(v => !Array.isArray(v) || v.length !== 3))
    throw new Error('实例变换必须包含原点和三个方向向量。')
  const c = value.map(v =>
    v.map((n: unknown) => {
      if (typeof n !== 'number') throw new Error('变换必须是数字。')
      return finite(n)
    }),
  )
  const dot = (a: number[], b: number[]) => a.reduce((s, n, i) => s + n * b[i], 0)
  for (let i = 1; i < 4; i++)
    for (let j = 1; j < 4; j++)
      if (Math.abs(dot(c[i], c[j]) - (i === j ? 1 : 0)) > 1e-6) throw new Error('只支持刚体变换，不能缩放或剪切。')
  const cross = [
    c[1][1] * c[2][2] - c[1][2] * c[2][1],
    c[1][2] * c[2][0] - c[1][0] * c[2][2],
    c[1][0] * c[2][1] - c[1][1] * c[2][0],
  ]
  if (dot(cross, c[3]) < 1 - 1e-6) throw new Error('实例变换必须为右手坐标系。')
  return c
}
export function validateMate(value: Mate | null, a: AssemblyData): Mate | null {
  if (value === null) return null
  if (!value || !Array.isArray(value.path) || value.path.length > 1) throw new Error('当前支持单层装配配合路径。')
  const path = value.path.map(id)
  const instance = path.length ? a.instances.find(i => i.id === path[0]) : undefined
  if (path.length && !instance) throw new Error('配合引用了不存在的实例。')
  // Stable origin and six rectangular solid face frames. IDs never depend on tessellation.
  const base = instance ? instance.productId - 1 : 0
  if (
    (!value.geometry && ![base + 100, ...Array.from({ length: 6 }, (_, i) => base + 110 + i)].includes(value.csys)) ||
    (!instance && value.csys !== 100)
  )
    throw new Error('配合坐标系无效，请选择实例的 Origin 或面坐标系。')
  if (!['X', '-X', 'Y', '-Y', 'Z', '-Z'].includes(value.flip) || !['0', '90', '180', '270'].includes(value.reorient))
    throw new Error('配合方向无效。')
  if (
    value.geometry &&
    (!instance ||
      !['plane', 'cylinder'].includes(value.geometry.kind) ||
      typeof value.geometry.key !== 'string' ||
      value.geometry.key.length > 8192 ||
      !value.geometry.key ||
      !Number.isSafeInteger(value.csys) ||
      value.csys - base < 6000 ||
      value.csys - base >= 10000)
  )
    throw new Error('配合几何引用无效。')
  return {
    path,
    csys: value.csys,
    flip: value.flip,
    reorient: value.reorient,
    ...(value.geometry ? { geometry: { key: value.geometry.key, kind: value.geometry.kind } } : {}),
  }
}
export function validateAssembly(input: AssemblyData): AssemblyData {
  if (!input || !Array.isArray(input.parts) || !Array.isArray(input.instances) || !Array.isArray(input.constraints))
    throw new Error('装配数据无效。')
  if (input.parts.length > 16 || input.instances.length > 16 || input.constraints.length > 64)
    throw new Error('当前本地装配支持最多 16 个零件模板、16 个实例和 64 个约束。')
  const a: AssemblyData = {
    parts: input.parts.map(p => {
      if (!p || p.document?.kind === 'assembly' || p.document?.assembly)
        throw new Error('零件模板必须是 Part，暂不支持子装配。')
      if (id(p.id) < 10001 || p.id > 160001 || p.id % 10000 !== 1) throw new Error('零件模板 ID 无效。')
      return { id: p.id, document: validateDocument(p.document) }
    }),
    instances: input.instances.map(i => ({
      id: id(i.id),
      productId: id(i.productId),
      name: label(i.name),
      csys: validateCSys(i.csys),
    })),
    constraints: [],
    nextPart: id(input.nextPart),
    nextInstance: id(input.nextInstance),
    nextConstraint: id(input.nextConstraint),
  }
  if (a.instances.some(i => i.id < 1000001 || i.id >= 2000000 || !a.parts.some(p => p.id === i.productId)))
    throw new Error('实例引用了不存在的零件模板。')
  a.constraints = input.constraints.map(c => {
    if (!c || !constraintTypes.includes(c.type) || c.id < 2000001 || typeof c.draft !== 'boolean')
      throw new Error('约束类型或 ID 无效。')
    const mate1 = validateMate(c.mate1, a),
      mate2 = validateMate(c.mate2, a)
    if (!c.draft && (!mate1 || (c.type !== 'FastenedOrigin' && !mate2))) throw new Error('约束需要完整的配合引用。')
    if (!c.draft && c.type === 'FastenedOrigin' && !mate1?.path.length) throw new Error('固定到原点需要选择一个实例。')
    if (mate1 && mate2 && (mate1.path[0] ?? 1) === (mate2.path[0] ?? 1)) throw new Error('不能在同一刚体之间添加约束。')
    if (c.type === 'Cylindrical' && [mate1, mate2].some(m => m?.geometry && m.geometry.kind !== 'cylinder'))
      throw new Error('同轴配合请选择孔壁或轴的圆柱面。')
    if (c.type === 'Planar' && [mate1, mate2].some(m => m?.geometry && m.geometry.kind !== 'plane'))
      throw new Error('贴合配合请选择平面。')
    const values: Record<string, number> = {}
    const allowed = /^(x|y|z)(Offset|Rotation)(Value)?$/
    for (const [key, value] of Object.entries(c.values || {})) {
      if (!allowed.test(key) || typeof value !== 'number') throw new Error('约束参数无效。')
      values[key] = finite(value)
    }
    const limits: typeof c.limits = {}
    for (const [key, limit] of Object.entries(c.limits || {})) {
      if (!/^(x|y|z)(Offset|Rotation)Limits$/.test(key)) throw new Error('约束限位无效。')
      limits[key] = limit
        ? { min: limit.min === null ? null : finite(limit.min), max: limit.max === null ? null : finite(limit.max) }
        : null
      if (limits[key]?.min != null && limits[key]?.max != null && limits[key]!.min! > limits[key]!.max!)
        throw new Error('限位最小值不能大于最大值。')
    }
    return { id: id(c.id), name: label(c.name), type: c.type, draft: c.draft, mate1, mate2, values, limits }
  })
  for (const objects of [a.parts, a.instances, a.constraints])
    if (new Set(objects.map(o => o.id)).size !== objects.length) throw new Error('装配 ID 重复。')
  if (
    a.nextPart > 17 ||
    a.parts.some(p => p.id >= a.nextPart * 10000 + 1) ||
    a.instances.some(i => i.id >= 1000000 + a.nextInstance) ||
    a.constraints.some(c => c.id >= 2000000 + a.nextConstraint)
  )
    throw new Error('装配 ID 计数器无效。')
  return a
}
