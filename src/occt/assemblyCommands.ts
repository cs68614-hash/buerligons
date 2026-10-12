import {
  AssemblyConstraint,
  CadDocument,
  constraintTypes,
  emptyAssembly,
  emptyDocument,
  identityCSys,
  ModelView,
  KernelResult,
  parseDocument,
} from './model'
import { finite } from './assemblyModel'
import { constraintFreeAxes, relativeValues } from './assemblySolver'
import type { NativeChange } from './nativeCommands'
import { importStepDocument } from './stepDocument'

const point = (p: any): number[] => (Array.isArray(p) ? p : [p?.x, p?.y, p?.z]).map(v => finite(v))
const transform = (value: any): number[][] => {
  if (!value) return identityCSys()
  const c = value.map(point)
  if (c.length === 3)
    c.push([
      c[1][1] * c[2][2] - c[1][2] * c[2][1],
      c[1][2] * c[2][0] - c[1][0] * c[2][2],
      c[1][0] * c[2][1] - c[1][1] * c[2][0],
    ])
  return c
}
const mateInput = (p: any) =>
  p
    ? {
        path: (p.path || []).map(Number).filter((id: number) => id !== 1),
        csys: Number(p.csys),
        flip: p.flip || 'Z',
        reorient: String(p.reorient || '0'),
      }
    : null

export function assemblyCommand(
  name: string,
  p: any,
  d: CadDocument,
  view: ModelView,
  geometry?: KernelResult,
): NativeChange {
  const a = d.assembly || (d.assembly = emptyAssembly())
  const mate = (input: any) => {
    const result = mateInput(input)
    if (!result) return null
    const instance = a.instances.find(i => i.id === result.path[0])
    const face = instance && geometry?.parts?.[instance.productId]?.mateFrames?.[result.csys - instance.productId + 1]
    return {
      ...result,
      ...(face ? { geometry: { key: face.key, kind: face.kind } } : input.geometry ? { geometry: input.geometry } : {}),
    }
  }
  const freshPart = (document: CadDocument): number => {
    if (document.kind === 'assembly') throw new Error('请导入 Part 的 .occt.json，暂不支持子装配。')
    const slot = Array.from({ length: 16 }, (_, i) => i + 1).find(n => !a.parts.some(part => part.id === n * 10000 + 1))
    if (!slot) throw new Error('当前本地装配支持最多 16 个零件模板。')
    const id = slot * 10000 + 1
    a.nextPart = Math.max(a.nextPart, slot + 1)
    a.parts.push({ id, document })
    return id
  }
  switch (name) {
    case 'v1.assembly.partTemplate':
      return { document: d, result: freshPart({ ...emptyDocument(), name: p.name || 'New Part' }) }
    case 'v1.assembly.loadProduct': {
      if (p.url || p.file || p.compression || (p.encoding && p.encoding !== 'base64'))
        throw new Error('请使用原生 Import 选择本地 .occt.json 零件文件。')
      if (!['OCCT_JSON', 'STP', 'STEP'].includes(p.format)) throw new Error('本地装配导入支持 .occt.json 和 STEP。')
      const input =
        p.encoding === 'base64'
          ? new TextDecoder().decode(Uint8Array.from(atob(p.data), char => char.charCodeAt(0)))
          : typeof p.data === 'string'
          ? p.data
          : new TextDecoder().decode(p.data)
      return {
        document: d,
        result: {
          id: freshPart(
            p.format === 'OCCT_JSON' ? parseDocument(input) : importStepDocument(p.name || 'STEP Part', input),
          ),
        },
      }
    }
    case 'v1.assembly.setCurrentInstance': {
      if (p.id === 1) return { result: true, view: { productId: 1, instanceId: 1 } }
      const instance = a.instances.find(i => i.id === p.id),
        productId = instance?.productId || p.id
      if (!a.parts.some(part => part.id === productId)) throw new Error('找不到要编辑的零件。')
      return { result: true, view: { productId, instanceId: instance?.id || productId } }
    }
    case 'v1.assembly.instance': {
      if (p.ownerId !== 1 || view.productId !== 1) throw new Error('请返回装配根节点后插入零件。')
      const product = a.parts.find(part => part.id === p.productId)
      if (!product) throw new Error('找不到零件模板。')
      const id = 1000000 + a.nextInstance++
      a.instances.push({
        id,
        productId: product.id,
        name: p.name || `${product.document.name} ${a.instances.filter(i => i.productId === product.id).length + 1}`,
        csys: transform(p.transformation),
      })
      return { document: d, result: id }
    }
    case 'v1.assembly.deleteInstance': {
      if (!Array.isArray(p.ids) || p.ids.some((id: number) => !a.instances.some(i => i.id === id)))
        throw new Error('实例 ID 无效。')
      a.instances = a.instances.filter(i => !p.ids.includes(i.id))
      a.constraints = a.constraints.filter(c => !p.ids.includes(c.mate1?.path[0]) && !p.ids.includes(c.mate2?.path[0]))
      return { document: d, result: true }
    }
    case 'v1.assembly.deleteTemplate':
      if (!Array.isArray(p.ids) || p.ids.some((id: number) => !a.parts.some(i => i.id === id)))
        throw new Error('模板 ID 无效。')
      if (a.instances.some(i => p.ids.includes(i.productId))) throw new Error('请先删除引用该零件的实例。')
      a.parts = a.parts.filter(part => !p.ids.includes(part.id))
      return { document: d, result: true }
    case 'v1.assembly.deleteConstraint':
      if (!Array.isArray(p.ids) || p.ids.some((id: number) => !a.constraints.some(i => i.id === id)))
        throw new Error('约束 ID 无效。')
      a.constraints = a.constraints.filter(c => !p.ids.includes(c.id))
      return { document: d, result: true }
    case 'v1.assembly.createUncommitedObject': {
      if (view.productId !== 1) throw new Error('请返回 Assembly 后添加装配约束。')
      const type = String(p.type)
        .replace(/^CC_/, '')
        .replace(/Constraint$/, '')
      if (!constraintTypes.includes(type as any)) throw new Error(`本地装配尚未实现 ${type}。`)
      const id = 2000000 + a.nextConstraint++
      a.constraints.push({
        id,
        name: p.name || type,
        type: type as any,
        draft: true,
        mate1: null,
        mate2: null,
        values: {},
        limits: {},
      })
      return { document: d, result: id }
    }
    case 'v1.assembly.update3DConstraintValue': {
      const c = a.constraints.find(candidate => candidate.id === p.id)
      if (!c || c.draft) throw new Error('请先应用配合约束。')
      const property = String(p.name)
        .toLowerCase()
        .replace(/_([a-z])/g, (_, v) => v.toUpperCase())
      if (!constraintFreeAxes(c.type).includes(property)) throw new Error('该方向没有可调的自由度。')
      const value = finite(p.value, property.includes('Rotation')),
        limit = c.limits[property + 'Limits']
      if ((limit?.min != null && value < limit.min) || (limit?.max != null && value > limit.max))
        throw new Error('目标值超出配合限位。')
      return { document: d, result: true, drive: { constraintId: c.id, name: property, value } }
    }
    default: {
      const method = name.replace('v1.assembly.', '')
      const type = constraintTypes.find(t => method === t[0].toLowerCase() + t.slice(1) || method === 'update' + t)
      if (!type) throw new Error(`本地装配尚未实现 ${name}。`)
      let c = a.constraints.find(candidate => candidate.id === p.id)
      if (method.startsWith('update')) {
        if (!c || c.type !== type) throw new Error('找不到要编辑的装配约束。')
      } else {
        if (p.id !== 1) throw new Error('约束必须创建在装配根节点。')
        c = {
          id: 2000000 + a.nextConstraint++,
          name: p.name || type,
          type,
          draft: true,
          mate1: null,
          mate2: null,
          values: {},
          limits: {},
        }
        a.constraints.push(c)
      }
      c = c as AssemblyConstraint
      if (p.mate1 !== undefined) c.mate1 = mate(p.mate1) as any
      if (p.mate2 !== undefined) c.mate2 = mate(p.mate2) as any
      if (!c.mate1 || (type !== 'FastenedOrigin' && !c.mate2)) throw new Error('请先选择完整的配合坐标系。')
      if (
        (type === 'Cylindrical' && [c.mate1, c.mate2].some(m => m?.geometry && m.geometry.kind !== 'cylinder')) ||
        (type === 'Planar' && [c.mate1, c.mate2].some(m => m?.geometry && m.geometry.kind !== 'plane'))
      )
        throw new Error(type === 'Cylindrical' ? '同轴配合请选择孔壁或轴的圆柱面。' : '贴合配合请选择平面。')
      for (const key of ['xOffset', 'yOffset', 'zOffset', 'xRotation', 'yRotation', 'zRotation'])
        if (p[key] !== undefined) c.values[key] = finite(p[key], key.includes('Rotation'))
      for (const key of ['xOffsetLimits', 'yOffsetLimits', 'zOffsetLimits', 'yRotationLimits', 'zRotationLimits'])
        if (p[key] !== undefined)
          c.limits[key] = p[key]
            ? {
                min: p[key].min == null ? null : finite(p[key].min, key.includes('Rotation')),
                max: p[key].max == null ? null : finite(p[key].max, key.includes('Rotation')),
              }
            : null
      if (p.useCurrentTransform) {
        if (type !== 'Fastened' && type !== 'FastenedOrigin') throw new Error('此约束不支持使用当前变换。')
        Object.assign(
          c.values,
          relativeValues(d, c, Object.fromEntries(a.instances.map(i => [i.id, i.csys])), geometry?.parts),
        )
      }
      c.draft = false
      return { document: d, result: c.id }
    }
  }
}
