import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { AssemblyConstraint, CadDocument, CoordinateSystem, identityCSys, Mate, KernelResult } from './model'

export type PartGeometry = Record<number, KernelResult>
export type MotionDrive = { constraintId: number; name: string; value: number }
export const csysMatrix = (c: CoordinateSystem): Matrix4 =>
  new Matrix4().set(
    c[1][0],
    c[2][0],
    c[3][0],
    c[0][0],
    c[1][1],
    c[2][1],
    c[3][1],
    c[0][1],
    c[1][2],
    c[2][2],
    c[3][2],
    c[0][2],
    0,
    0,
    0,
    1,
  )
export const matrixCSys = (m: Matrix4): CoordinateSystem => {
  const e = m.elements
  return [
    [e[12], e[13], e[14]],
    [e[0], e[1], e[2]],
    [e[4], e[5], e[6]],
    [e[8], e[9], e[10]],
  ]
}
export function partMateFrames(d: CadDocument): Record<number, CoordinateSystem> {
  const frames: Record<number, CoordinateSystem> = { 100: identityCSys() }
  if (d.engineering) {
    const sketch = d.engineering.features.find(f => f.type === 'sketch' && f.planeId === 104),
      extrusion = d.engineering.features.find(f => f.type === 'extrusion' && f.direction === 'UP')
    if (
      sketch?.type !== 'sketch' ||
      extrusion?.type !== 'extrusion' ||
      sketch.entities.length !== 4 ||
      sketch.entities.some(e => e.type !== 'line')
    )
      return frames
    const xs = sketch.points.map(p => p.x),
      ys = sketch.points.map(p => p.y),
      xValue = Math.min(...xs),
      yValue = Math.min(...ys),
      width = Math.max(...xs) - xValue,
      height = Math.max(...ys) - yValue
    if (
      sketch.points.some(
        p =>
          (Math.abs(p.x - xValue) > 1e-5 && Math.abs(p.x - xValue - width) > 1e-5) ||
          (Math.abs(p.y - yValue) > 1e-5 && Math.abs(p.y - yValue - height) > 1e-5),
      )
    )
      return frames
    return partMateFrames({
      ...d,
      engineering: undefined,
      rectangle: { x: xValue, y: yValue, width, height },
      extrusion: { depth: extrusion.depth },
    })
  }
  if (!d.rectangle || !d.extrusion) return frames
  const { x, y, width: w, height: h } = d.rectangle,
    z = d.extrusion.depth
  const centers = [
    [x + w / 2, y + h / 2, 0],
    [x + w / 2, y + h / 2, z],
    [x, y + h / 2, z / 2],
    [x + w, y + h / 2, z / 2],
    [x + w / 2, y, z / 2],
    [x + w / 2, y + h, z / 2],
  ]
  const normals = [
    [0, 0, -1],
    [0, 0, 1],
    [-1, 0, 0],
    [1, 0, 0],
    [0, -1, 0],
    [0, 1, 0],
  ]
  centers.forEach((p, i) => {
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...normals[i]))
    frames[110 + i] = matrixCSys(
      new Matrix4().makeRotationFromQuaternion(q).setPosition(...(p as [number, number, number])),
    )
  })
  return frames
}
export function mateLocal(d: CadDocument, mate: Mate, parts?: PartGeometry): Matrix4 {
  const a = d.assembly!
  const instance = mate.path.length ? a.instances.find(i => i.id === mate.path[0]) : undefined
  const part = instance && a.parts.find(p => p.id === instance.productId)
  const base = part ? part.id - 1 : 0
  const frames = part ? partMateFrames(part.document) : { 100: identityCSys() }
  const face =
    mate.geometry &&
    part &&
    Object.values(parts?.[part.id]?.mateFrames || {}).find(
      f => f.key === mate.geometry!.key && f.kind === mate.geometry!.kind,
    )
  const frame = mate.geometry ? face && face.frame : frames[mate.csys - base]
  if (!frame) throw new Error('配合面已经不存在或发生歧义，请重新选择配合；修改未提交。')
  const local = csysMatrix(frame)
  const directions: Record<string, number[]> = {
    X: [1, 0, 0],
    '-X': [-1, 0, 0],
    Y: [0, 1, 0],
    '-Y': [0, -1, 0],
    Z: [0, 0, 1],
    '-Z': [0, 0, -1],
  }
  const flip = new Matrix4().makeRotationFromQuaternion(
    new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...directions[mate.flip])),
  )
  return local.multiply(flip).multiply(new Matrix4().makeRotationZ((Number(mate.reorient) * Math.PI) / 180))
}
export function mateWorld(
  d: CadDocument,
  mate: Mate,
  poses: Record<number, CoordinateSystem>,
  parts?: PartGeometry,
): Matrix4 {
  return (mate.path.length ? csysMatrix(poses[mate.path[0]]) : new Matrix4()).multiply(mateLocal(d, mate, parts))
}
export const offsetMatrix = (c: AssemblyConstraint): Matrix4 =>
  new Matrix4()
    .makeRotationFromEuler(new Euler(c.values.xRotation || 0, c.values.yRotation || 0, c.values.zRotation || 0, 'XYZ'))
    .setPosition(c.values.xOffset || 0, c.values.yOffset || 0, c.values.zOffset || 0)

export function relativeValues(
  d: CadDocument,
  c: AssemblyConstraint,
  poses: Record<number, CoordinateSystem>,
  parts?: PartGeometry,
): Record<string, number> {
  if (!c.mate1 || (!c.mate2 && c.type !== 'FastenedOrigin')) return {}
  const rel =
    c.type === 'FastenedOrigin'
      ? mateWorld(d, c.mate1, poses, parts)
      : mateWorld(d, c.mate1, poses, parts)
          .invert()
          .multiply(mateWorld(d, c.mate2!, poses, parts))
  const e = new Euler().setFromRotationMatrix(rel, 'XYZ'),
    p = new Vector3().setFromMatrixPosition(rel)
  return { xOffset: p.x, yOffset: p.y, zOffset: p.z, xRotation: e.x, yRotation: e.y, zRotation: e.z }
}
const rotationLog = (m: Matrix4): number[] => {
  const q = new Quaternion().setFromRotationMatrix(m).normalize()
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w)
  const s = Math.hypot(q.x, q.y, q.z),
    scale = s < 1e-12 ? 2 : (2 * Math.atan2(s, q.w)) / s
  return [q.x * scale, q.y * scale, q.z * scale]
}
const axes: Record<string, number[]> = {
  FastenedOrigin: [0, 1, 2, 3, 4, 5],
  Fastened: [0, 1, 2, 3, 4, 5],
  Slider: [0, 1, 3, 4, 5],
  Revolute: [0, 1, 2, 3, 4],
  Cylindrical: [0, 1, 3, 4],
  Planar: [2, 3, 4],
  Parallel: [3, 4],
  Spherical: [0, 1, 2],
}
const freeAxes: Record<string, string[]> = {
  FastenedOrigin: [],
  Fastened: [],
  Slider: ['zOffset'],
  Revolute: ['zRotation'],
  Cylindrical: ['zOffset', 'zRotation'],
  Planar: ['xOffset', 'yOffset', 'zRotation'],
  Parallel: ['xOffset', 'yOffset', 'zOffset', 'zRotation'],
  Spherical: ['xRotation', 'yRotation', 'zRotation'],
}
export const constraintFreeAxes = (type: string): string[] => freeAxes[type] || []
const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b))

/** Small rigid-body solver, separate from OCCT's BRep modeling. All poses solve together. */
export function solveAssembly(
  d: CadDocument,
  drive?: MotionDrive,
  parts?: PartGeometry,
): Record<number, CoordinateSystem> {
  const a = d.assembly!
  let poses = Object.fromEntries(a.instances.map(i => [i.id, structuredClone(i.csys)]))
  const constraints = a.constraints.filter(c => !c.draft)
  if (!constraints.length) return poses
  const residual = (at: typeof poses): number[] => {
    const r: number[] = []
    for (const c of constraints) {
      const first = mateWorld(d, c.mate1!, at, parts)
      const target = c.type === 'FastenedOrigin' ? offsetMatrix(c) : first.clone().multiply(offsetMatrix(c))
      const subject = c.type === 'FastenedOrigin' ? first : mateWorld(d, c.mate2!, at, parts)
      const relative = target.invert().multiply(subject)
      const p = new Vector3().setFromMatrixPosition(relative),
        rot = rotationLog(relative)
      const components = [p.x, p.y, p.z, ...rot.map(v => v * 100)]
      r.push(...axes[c.type].map(i => components[i]))
      const values = relativeValues(d, c, at, parts)
      for (const axis of freeAxes[c.type]) {
        const value = values[axis],
          limit = c.limits[axis + 'Limits'],
          scale = axis.includes('Rotation') ? 100 : 1
        r.push(limit?.min != null ? Math.min(0, value - limit.min) * scale : 0)
        r.push(limit?.max != null ? Math.max(0, value - limit.max) * scale : 0)
        if (drive?.constraintId === c.id && drive.name === axis)
          r.push((axis.includes('Rotation') ? angleDiff(value, drive.value) : value - drive.value) * scale)
      }
    }
    return r
  }
  const n = a.instances.length * 6
  const perturb = (at: typeof poses, change: number[]): typeof poses =>
    Object.fromEntries(
      a.instances.map((instance, i) => {
        const base = csysMatrix(at[instance.id]),
          dv = change.slice(i * 6, i * 6 + 6)
        const position = new Vector3().setFromMatrixPosition(base).add(new Vector3(...dv.slice(0, 3)))
        const rotation = new Vector3(...dv.slice(3)),
          angle = rotation.length()
        if (angle > 1e-14) base.premultiply(new Matrix4().makeRotationAxis(rotation.divideScalar(angle), angle))
        return [instance.id, matrixCSys(base.setPosition(position))]
      }),
    )
  let damping = 1e-5
  for (let iteration = 0; iteration < 100; iteration++) {
    const r = residual(poses),
      score = r.reduce((s, v) => s + v * v, 0)
    if (Math.max(0, ...r.map(Math.abs)) < 1e-5) return poses
    const columns: number[][] = []
    for (let j = 0; j < n; j++) {
      const step = Array(n).fill(0),
        h = j % 6 < 3 ? 1e-4 : 1e-6
      step[j] = h
      const perturbedResidual = residual(perturb(poses, step))
      columns.push(perturbedResidual.map((v, k) => (v - r[k]) / h))
    }
    const normal = columns.map((col, i) => [
      ...columns.map((other, j) => col.reduce((s, v, k) => s + v * other[k], 0) + (i === j ? damping : 0)),
      -col.reduce((s, v, k) => s + v * r[k], 0),
    ])
    // Pivoted dense solve for damped least squares; underconstrained motion stays near the input pose.
    for (let j = 0; j < n; j++) {
      let pivot = j
      for (let k = j + 1; k < n; k++) if (Math.abs(normal[k][j]) > Math.abs(normal[pivot][j])) pivot = k
      ;[normal[j], normal[pivot]] = [normal[pivot], normal[j]]
      const divisor = normal[j][j]
      if (Math.abs(divisor) < 1e-15) throw new Error('装配约束数值求解失败。')
      for (let k = j; k <= n; k++) normal[j][k] /= divisor
      for (let row = 0; row < n; row++)
        if (row !== j) {
          const factor = normal[row][j]
          for (let k = j; k <= n; k++) normal[row][k] -= factor * normal[j][k]
        }
    }
    const delta = normal.map(row => row[n])
    if (delta.some(v => !Number.isFinite(v))) throw new Error('装配约束数值求解失败。')
    // Limit angular steps to avoid jumping across the quaternion branch cut.
    const maxRotation = Math.max(1, ...a.instances.map((_, i) => Math.hypot(...delta.slice(i * 6 + 3, i * 6 + 6))))
    const next = perturb(
        poses,
        delta.map(v => v / maxRotation),
      ),
      nextScore = residual(next).reduce((s, v) => s + v * v, 0)
    if (nextScore < score) {
      poses = next
      damping = Math.max(1e-9, damping / 3)
    } else damping = Math.min(1e12, damping * 10)
  }
  throw new Error('装配约束冲突或无法收敛，修改未提交。请检查重复固定、偏移及限位。')
}
