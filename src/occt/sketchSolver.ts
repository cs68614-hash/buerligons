import { SketchConstraint, SketchEntity, SketchFeature, SketchPoint } from './engineeringModel'

export const getPoint = (s: SketchFeature, id: number): SketchPoint => {
  const p = s.points.find(candidatePoint => candidatePoint.id === id)
  if (!p) throw new Error('找不到草图点。')
  return p
}
export const getEntity = (s: SketchFeature, id: number): SketchEntity => {
  const e = s.entities.find(candidateEntity => candidateEntity.id === id)
  if (!e) throw new Error('找不到草图曲线。')
  return e
}
export const entityPoints = (s: SketchFeature, id: number): number[] => {
  if (s.points.some(p => p.id === id)) return [id]
  const e = getEntity(s, id)
  return e.type === 'line' ? [e.start!, e.end!] : e.type === 'circle' ? [e.center!] : [e.start!, e.end!, e.center!]
}
const distance = (a: SketchPoint, b: SketchPoint) => Math.hypot(a.x - b.x, a.y - b.y)
export const fixedValues = (s: SketchFeature, ids: number[]): number[] => ids.flatMap(id => {
  const coordinates = entityPoints(s, id).flatMap(pointId => { const p = getPoint(s, pointId); return [p.x, p.y] })
  const circle = s.entities.find(e => e.id === id && e.type === 'circle')
  return circle ? [...coordinates, circle.radius!] : coordinates
})
export const radius = (s: SketchFeature, e: SketchEntity): number =>
  e.type === 'circle' ? e.radius! : distance(getPoint(s, e.start!), getPoint(s, e.center!))
const line = (s: SketchFeature, id: number): SketchPoint[] => {
  const e = getEntity(s, id)
  if (e.type !== 'line') throw new Error('此约束需要直线。')
  return [getPoint(s, e.start!), getPoint(s, e.end!)]
}
const pair = (s: SketchFeature, ids: number[]): SketchPoint[] => {
  if (ids.length === 1) return line(s, ids[0])
  if (ids.length !== 2 || ids.some(id => !s.points.some(p => p.id === id)))
    throw new Error('此尺寸需要两个点或一条直线。')
  return ids.map(id => getPoint(s, id))
}
const vector = (p: SketchPoint[]) => [p[1].x - p[0].x, p[1].y - p[0].y]
const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b))
export function measured(s: SketchFeature, type: string, ids: number[]): number {
  if (type === 'RADIUS' || type === 'DIAMETER') return radius(s, getEntity(s, ids[0])) * (type === 'DIAMETER' ? 2 : 1)
  if (type === 'ANGLEOX') {
    const v = vector(line(s, ids[0]))
    return Math.atan2(v[1], v[0])
  }
  if (type === 'ANGLE') {
    const aValue = vector(line(s, ids[0])),
      bValue = vector(line(s, ids[1]))
    return angleDifference(Math.atan2(bValue[1], bValue[0]), Math.atan2(aValue[1], aValue[0]))
  }
  const [a, b] = pair(s, ids)
  if (type === 'HORIZONTAL_DISTANCE') return Math.abs(b.x - a.x)
  if (type === 'VERTICAL_DISTANCE') return Math.abs(b.y - a.y)
  return distance(a, b)
}
/** Every accepted constraint contributes equations; unsupported combinations fail explicitly. */
function equations(s: SketchFeature, c: SketchConstraint): number[] {
  const ids = c.entities,
    p = (id: number) => getPoint(s, id),
    e = (id: number) => getEntity(s, id)
  switch (c.type) {
    case 'FIXATION': {
      const values = fixedValues(s, ids)
      if (c.fixed?.length !== values.length) throw new Error('固定约束数据无效。')
      return values.map((v, i) => v - c.fixed![i])
    }
    case 'COINCIDENT': {
      if (ids.length !== 2) throw new Error('重合约束需要两个点。')
      return [p(ids[0]).x - p(ids[1]).x, p(ids[0]).y - p(ids[1]).y]
    }
    case 'HORIZONTAL':
    case 'VERTICAL': {
      const [a, b] = pair(s, ids)
      return [c.type === 'HORIZONTAL' ? b.y - a.y : b.x - a.x]
    }
    case 'HORIZONTAL_DISTANCE':
    case 'VERTICAL_DISTANCE':
    case 'OFFSET':
    case 'RADIUS':
    case 'DIAMETER':
      return [measured(s, c.type, ids) - c.value!]
    case 'ANGLE':
    case 'ANGLEOX':
      return [angleDifference(measured(s, c.type, ids), c.value!) * 50]
    case 'PARALLEL':
    case 'PERPENDICULAR':
    case 'COLINEAR': {
      if (ids.length !== 2) throw new Error('此约束需要两条直线。')
      const a = line(s, ids[0]),
        b = line(s, ids[1]),
        u = vector(a),
        v = vector(b),
        scale = Math.max(1, Math.hypot(...u), Math.hypot(...v))
      const r = [(c.type === 'PERPENDICULAR' ? u[0] * v[0] + u[1] * v[1] : u[0] * v[1] - u[1] * v[0]) / scale]
      if (c.type === 'COLINEAR')
        r.push(((b[0].x - a[0].x) * u[1] - (b[0].y - a[0].y) * u[0]) / Math.max(1, Math.hypot(...u)))
      return r
    }
    case 'EQUAL_LENGTH': {
      const a = ids.length === 4 ? pair(s, ids.slice(0, 2)) : line(s, ids[0]),
        b = ids.length === 4 ? pair(s, ids.slice(2)) : line(s, ids[1])
      return [distance(a[0], a[1]) - distance(b[0], b[1])]
    }
    case 'EQUAL_RADIUS':
      return [radius(s, e(ids[0])) - radius(s, e(ids[1]))]
    case 'CONCENTRIC': {
      const a = p(e(ids[0]).center!),
        b = p(e(ids[1]).center!)
      return [a.x - b.x, a.y - b.y]
    }
    case 'MIDPOINT': {
      let a: SketchPoint, b: SketchPoint, mid: SketchPoint
      if (ids.length === 3) {
        a = p(ids[0])
        mid = p(ids[1])
        b = p(ids[2])
      } else {
        const ln = ids.find(id =>
          s.entities.some(candidateEntity => candidateEntity.id === id && candidateEntity.type === 'line'),
        )!
        ;[a, b] = line(s, ln)
        mid = p(ids.find(id => id !== ln)!)
      }
      return [mid.x - (a.x + b.x) / 2, mid.y - (a.y + b.y) / 2]
    }
    case 'TANGENT': {
      const [a, b] = ids.map(e)
      if (a.type === 'line' || b.type === 'line') {
        const ln = a.type === 'line' ? a : b,
          round = a.type === 'line' ? b : a,
          [p1, p2] = line(s, ln.id),
          v = vector([p1, p2]),
          center = p(round.center!)
        return [
          Math.abs((center.x - p1.x) * v[1] - (center.y - p1.y) * v[0]) / Math.max(1e-9, Math.hypot(...v)) -
            radius(s, round),
        ]
      }
      return [distance(p(a.center!), p(b.center!)) - radius(s, a) - radius(s, b)]
    }
    default:
      throw new Error(`尚未支持草图约束 ${c.type}。`)
  }
}
function rank(matrix: number[][]): number {
  const a = matrix.map(matrixRow => [...matrixRow])
  if (!a.length) return 0
  let row = 0
  for (let col = 0; col < a[0].length && row < a.length; col++) {
    let pivot = row
    for (let i = row + 1; i < a.length; i++) if (Math.abs(a[i][col]) > Math.abs(a[pivot][col])) pivot = i
    if (Math.abs(a[pivot][col]) < 1e-6) continue
    ;[a[row], a[pivot]] = [a[pivot], a[row]]
    const k = a[row][col]
    for (let j = col; j < a[row].length; j++) a[row][j] /= k
    for (let i = row + 1; i < a.length; i++) {
      const q = a[i][col]
      for (let j = col; j < a[i].length; j++) a[i][j] -= q * a[row][j]
    }
    row++
  }
  return row
}
export function solveSketch(s: SketchFeature): void {
  const circles = s.entities.filter(e => e.type === 'circle'),
    initial = [...s.points.flatMap(p => [p.x, p.y]), ...circles.map(e => e.radius!)]
  let x = [...initial]
  const write = (v: number[]) => {
    s.points.forEach((p, i) => {
      p.x = v[2 * i]
      p.y = v[2 * i + 1]
    })
    circles.forEach((e, i) => (e.radius = v[s.points.length * 2 + i]))
  }
  const residual = (v: number[]) => {
    write(v)
    return [
      ...s.constraints.flatMap(c => equations(s, c)),
      ...s.entities
        .filter(e => e.type === 'arc')
        .map(
          e =>
            distance(getPoint(s, e.start!), getPoint(s, e.center!)) -
            distance(getPoint(s, e.end!), getPoint(s, e.center!)),
        ),
    ]
  }
  const jacobian = (at: number[], r: number[]) =>
    at.map((v, j) => {
      const h = 1e-5 * Math.max(1, Math.abs(v)),
        next = [...at]
      next[j] += h
      return residual(next).map((component, i) => (component - r[i]) / h)
    })
  let damping = 1e-5
  for (let iteration = 0; iteration < 100; iteration++) {
    const r = residual(x),
      maximum = Math.max(0, ...r.map(Math.abs))
    if (maximum < 1e-6) {
      const derivatives = jacobian(x, r)
      write(x)
      s.residual = maximum
      s.dof = x.length - rank(r.map((_, i) => derivatives.map(col => col[i])))
      for (const e of s.entities) {
        if (e.type === 'circle' && e.radius! < 0.001) throw new Error('草图圆半径无效。')
        if (e.type === 'line' && distance(getPoint(s, e.start!), getPoint(s, e.end!)) < 1e-6)
          throw new Error('草图直线长度为零。')
      }
      return
    }
    const cols = jacobian(x, r),
      n = x.length,
      normal = cols.map((c, i) => [
        ...cols.map((other, j) => c.reduce((a, v, k) => a + v * other[k], 0) + (i === j ? damping : 0)),
        -c.reduce((a, v, k) => a + v * r[k], 0),
      ])
    for (let j = 0; j < n; j++) {
      let pivot = j
      for (let k = j + 1; k < n; k++) if (Math.abs(normal[k][j]) > Math.abs(normal[pivot][j])) pivot = k
      ;[normal[j], normal[pivot]] = [normal[pivot], normal[j]]
      const divisor = normal[j][j]
      if (Math.abs(divisor) < 1e-15) throw new Error('草图数值求解失败。')
      for (let k = j; k <= n; k++) normal[j][k] /= divisor
      for (let row = 0; row < n; row++)
        if (row !== j) {
          const q = normal[row][j]
          for (let k = j; k <= n; k++) normal[row][k] -= q * normal[j][k]
        }
    }
    const next = x.map((v, i) => v + normal[i][n]),
      score = (v: number[]) => v.reduce((a, componentValue) => a + componentValue * componentValue, 0)
    if (next.every(Number.isFinite) && score(residual(next)) < score(r)) {
      x = next
      damping = Math.max(1e-9, damping / 3)
    } else damping *= 10
  }
  write(initial)
  throw new Error('草图约束冲突或未收敛，修改未提交。请检查固定、尺寸和重复约束。')
}

export type SketchLoop = { curves: number[]; reversed: boolean[] }
/** Closed, nonbranching line/arc chains and circles; construction geometry never creates a profile. */
export function sketchLoops(s: SketchFeature, selected?: number[]): SketchLoop[] {
  const remaining = s.entities.filter(e => !e.construction && (!selected || selected.includes(e.id))),
    loops: SketchLoop[] = []
  const same = (a: number, b: number) => distance(getPoint(s, a), getPoint(s, b)) < 1e-5
  while (remaining.length) {
    const first = remaining.shift()!
    if (first.type === 'circle') {
      loops.push({ curves: [first.id], reversed: [false] })
      continue
    }
    const loop: SketchLoop = { curves: [first.id], reversed: [false] }
    let end = first.end!,
      closed = same(first.start!, end)
    while (!closed) {
      const candidates = remaining.filter(
        candidateEntity =>
          candidateEntity.type !== 'circle' && (same(end, candidateEntity.start!) || same(end, candidateEntity.end!)),
      )
      if (candidates.length !== 1) break
      const e = candidates[0],
        reverse = same(end, e.end!)
      remaining.splice(remaining.indexOf(e), 1)
      loop.curves.push(e.id)
      loop.reversed.push(reverse)
      end = reverse ? e.start! : e.end!
      closed = same(first.start!, end)
    }
    if (closed) loops.push(loop)
  }
  return loops
}
export const sketchFrame = (s: SketchFeature): number[][] =>
  s.planeId === 105
    ? [
        [0, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 0],
      ]
    : s.planeId === 106
    ? [
        [0, 0, 0],
        [1, 0, 0],
        [0, 0, -1],
        [0, 1, 0],
      ]
    : [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]
