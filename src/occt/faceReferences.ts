import { Vector3 } from 'three'
import { CadDocument, FaceMesh, KernelResult } from './model'
import { PartFeature, SketchFeature } from './engineeringModel'
import { getEntity, getPoint, radius, sketchFrame, sketchLoops } from './sketchSolver'

type Candidate = {
  key: string
  name: string
  kind: 'plane' | 'cylinder'
  normal: number[]
  point: number[]
  radius?: number
  bounds?: number[][]
}
const vec = (v: number[]) => new Vector3(...v)
const tolerance = 1e-5
const world = (s: SketchFeature, p: { x: number; y: number }): number[] => {
  const frame = sketchFrame(s)
  return frame[0].map((v, i) => v + p.x * frame[1][i] + p.y * frame[2][i])
}

/** Semantic names derive from feature/profile UUIDs. Ambiguous split/merged faces are deliberately unselectable. */
export function nameEngineeringFaces(d: CadDocument, featureId: number, geometry: KernelResult): void {
  const features = d.engineering!.features,
    body = features.find(f => f.id === featureId)!,
    candidates: Candidate[] = []
  const collect = (f: PartFeature, caps: boolean) => {
    if (f.type === 'boolean') {
      collect(features.find(v => v.id === f.target)!, caps)
      for (const tool of f.tools) collect(features.find(v => v.id === tool)!, caps && f.operation !== 'SUBTRACTION')
    }
    if (f.type !== 'extrusion') return
    const s = features.find((v): v is SketchFeature => v.id === f.sketchId && v.type === 'sketch')!,
      frame = sketchFrame(s),
      selected = f.references.flatMap(id => s.regions.find(r => r.id === id)?.curves || [id]),
      loops = sketchLoops(s, selected),
      start = f.direction === 'BOTH' ? -f.depth : 0,
      end = f.direction === 'DOWN' ? -f.depth : f.depth
    for (const id of new Set(selected)) {
      const entity = getEntity(s, id),
        prefix = `${body.uid}/${f.uid}/side/${entity.uid}`
      if (entity.type === 'line') {
        const a = world(s, getPoint(s, entity.start!)),
          b = world(s, getPoint(s, entity.end!)),
          normal = vec(b).sub(vec(a)).cross(vec(frame[3])).normalize().toArray()
        candidates.push({ key: prefix, name: `${f.name} · Line ${entity.id} face`, kind: 'plane', point: a, normal })
      } else {
        candidates.push({
          key: prefix,
          name: `${f.name} · Circle ${entity.id} axis`,
          kind: 'cylinder',
          point: world(s, getPoint(s, entity.center!)),
          normal: frame[3],
          radius: radius(s, entity),
        })
      }
    }
    if (caps)
      for (const loop of loops) {
        const ids = loop.curves
            .map(id => getEntity(s, id).uid)
            .sort()
            .join(','),
          points = loop.curves.flatMap(id => {
            const entity = getEntity(s, id)
            if (entity.type === 'line')
              return [world(s, getPoint(s, entity.start!)), world(s, getPoint(s, entity.end!))]
            const c = getPoint(s, entity.center!),
              r = radius(s, entity)
            return Array.from({ length: 64 }, (_, i) =>
              world(s, { x: c.x + r * Math.cos((i * Math.PI) / 32), y: c.y + r * Math.sin((i * Math.PI) / 32) }),
            )
          }),
          bounds = [
            points[0].map((_, i) => Math.min(...points.map(p => p[i]))),
            points[0].map((_, i) => Math.max(...points.map(p => p[i]))),
          ]
        for (const [role, length] of [
          ['start', start],
          ['end', end],
        ] as const)
          candidates.push({
            key: `${body.uid}/${f.uid}/${role}/${ids}`,
            name: `${f.name} · ${role} face`,
            kind: 'plane',
            point: frame[0].map((v, i) => v + frame[3][i] * length),
            normal: frame[3],
            bounds,
          })
      }
  }
  collect(body, true)
  for (const mesh of geometry.meshes) {
    if (!mesh.surface) continue
    if (body.type === 'import') {
      const fingerprint = [
        ...mesh.surface.frame[0],
        ...mesh.surface.frame[3],
        mesh.surface.radius || 0,
        ...[0, 1, 2].flatMap(axis => {
          const values = mesh.vertices.filter((_, i) => i % 3 === axis)
          return [Math.min(...values), Math.max(...values)]
        }),
      ]
        .map(v => Math.round(v * 1e6))
        .join(',')
      mesh.mate = {
        key: `${body.uid}/import/${mesh.surface.kind}/${fingerprint}`,
        name: `${body.name} · ${mesh.surface.kind} face`,
      }
      continue
    }
    const matches = candidates.filter(candidate => matchesSurface(candidate, mesh))
    if (matches.length === 1) mesh.mate = { key: matches[0].key, name: matches[0].name }
  }
  const counts = new Map<string, number>()
  for (const mesh of geometry.meshes) if (mesh.mate) counts.set(mesh.mate.key, (counts.get(mesh.mate.key) || 0) + 1)
  for (const mesh of geometry.meshes) if (mesh.mate && counts.get(mesh.mate.key)! > 1) delete mesh.mate
}

function matchesSurface(c: Candidate, mesh: FaceMesh): boolean {
  const surface = mesh.surface!,
    normal = vec(c.normal),
    origin = vec(c.point),
    actual = vec(surface.frame[0])
  if (surface.kind !== c.kind || Math.abs(Math.abs(normal.dot(vec(surface.frame[3]))) - 1) > tolerance) return false
  if (c.kind === 'cylinder')
    return actual.sub(origin).cross(normal).length() < tolerance && Math.abs(surface.radius! - c.radius!) < tolerance
  if (Math.abs(actual.sub(origin).dot(normal)) > tolerance) return false
  if (c.bounds)
    for (let i = 0; i < mesh.vertices.length; i += 3) {
      const p = vec(mesh.vertices.slice(i, i + 3)),
        shifted = p.addScaledVector(normal, -p.clone().sub(origin).dot(normal))
      // Cap bounds are measured in the sketch plane; ignore its normal coordinate.
      for (let axis = 0; axis < 3; axis++)
        if (
          Math.abs(normal.getComponent(axis)) < tolerance &&
          (shifted.getComponent(axis) < c.bounds[0][axis] - tolerance ||
            shifted.getComponent(axis) > c.bounds[1][axis] + tolerance)
        )
          return false
    }
  return true
}

export function attachFaceFrames(result: KernelResult): KernelResult {
  result.mateFrames = {}
  let graphicId = 3000,
    handle = 6000
  for (const body of result.bodies || [{ id: 1000, geometry: result }])
    for (const mesh of body.geometry.meshes) {
      if (mesh.mate && mesh.surface) {
        if (handle >= 10000) throw new Error('可配合面数量超过本地装配容量。')
        result.mateFrames[handle++] = { ...mesh.surface, ...mesh.mate, bodyId: body.id, graphicId }
      }
      graphicId++
    }
  return result
}
