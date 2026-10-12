import { CadDocument, KernelResult, CoordinateSystem, validateDocument } from './model'
import { csysMatrix, MotionDrive, partMateFrames, solveAssembly } from './assemblySolver'
import { Vector3 } from 'three'
import { meshShape, emptyGeometry } from './geometry'
import { rebuildEngineering } from './engineeringKernel'
import { attachFaceFrames } from './faceReferences'

/** All embind ownership stays here. The rest of the application only receives plain data. */
export function rebuild(oc: any, input: CadDocument, drive?: MotionDrive): KernelResult {
  const d = validateDocument(input)
  const empty: KernelResult = {
    meshes: [],
    lines: [],
    min: [0, 0, 0],
    max: [0, 0, 0],
    valid: true,
    volume: 0,
    faceCount: 0,
    edgeCount: 0,
  }
  if (d.kind === 'assembly' && d.assembly) {
    const a = d.assembly
    const parts = Object.fromEntries(a.parts.map(part => [part.id, rebuild(oc, part.document)]))
    const poses = solveAssembly(d, drive, parts)
    return assemblyResult(d, parts, poses)
  }
  if (d.engineering) return rebuildEngineering(oc, d)
  if (!d.rectangle) return empty
  const owned: any[] = []
  const keep = <T>(obj: T): T => {
    owned.push(obj)
    return obj
  }
  try {
    const { x, y, width, height } = d.rectangle
    const polygon = keep(new oc.BRepBuilderAPI_MakePolygon_1())
    for (const p of [
      [x, y, 0],
      [x + width, y, 0],
      [x + width, y + height, 0],
      [x, y + height, 0],
    ]) {
      const point = new oc.gp_Pnt_3(...p)
      try {
        polygon.Add_1(point)
      } finally {
        point.delete()
      }
    }
    polygon.Close()
    if (!polygon.IsDone()) throw new Error('OCCT 无法建立矩形闭合轮廓。')
    const wire = keep(polygon.Wire())
    const faceBuilder = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true))
    if (!faceBuilder.IsDone()) throw new Error('OCCT 无法建立草图平面。')
    const face = keep(faceBuilder.Face())
    let shape = face
    if (d.extrusion) {
      const vector = keep(new oc.gp_Vec_4(0, 0, d.extrusion.depth))
      const prism = keep(new oc.BRepPrimAPI_MakePrism_1(face, vector, false, true))
      shape = keep(prism.Shape())
    }
    const result = meshShape(oc, shape, !!d.extrusion)
    if (d.extrusion) {
      const frames = Object.entries(partMateFrames(d)).filter(([id]) => Number(id) !== 100),
        names = ['Bottom', 'Top', 'Left', 'Right', 'Front', 'Back']
      for (const mesh of result.meshes) {
        const surface = mesh.surface
        const match =
          surface &&
          frames.find(
            ([, frame]) =>
              new Vector3(...surface.frame[3]).distanceTo(new Vector3(...frame[3])) < 1e-6 &&
              Math.abs(new Vector3(...surface.frame[0]).sub(new Vector3(...frame[0])).dot(new Vector3(...frame[3]))) <
                1e-6,
          )
        if (match) mesh.mate = { key: 'legacy/rectangle/' + match[0], name: names[Number(match[0]) - 110] }
      }
      attachFaceFrames(result)
    }
    return result
  } finally {
    for (const obj of owned.reverse()) obj.delete()
  }
}

/** Reuses unchanged template geometry for an already certified, constraint-valid pose. */
export function assemblyResult(
  d: CadDocument,
  parts: Record<number, KernelResult>,
  poses: Record<number, CoordinateSystem>,
): KernelResult {
  const a = d.assembly!,
    result = { ...emptyGeometry(), parts, poses }
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity]
  for (const instance of a.instances) {
    const part = parts[instance.productId],
      transform = csysMatrix(poses[instance.id])
    result.volume += part.volume
    result.faceCount += part.faceCount
    result.edgeCount += part.edgeCount
    if (!part.faceCount) continue
    for (let corner = 0; corner < 8; corner++) {
      const p = new Vector3(...[0, 1, 2].map(axis => (corner & (1 << axis) ? part.max[axis] : part.min[axis])))
        .applyMatrix4(transform)
        .toArray()
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], p[axis])
        max[axis] = Math.max(max[axis], p[axis])
      }
    }
  }
  if (min.every(Number.isFinite)) {
    result.min = min
    result.max = max
  }
  return result
}
