import { FaceMesh, KernelResult } from './model'
import { analyticSurface } from './analyticSurface'

export const emptyGeometry = (): KernelResult => ({
  meshes: [],
  lines: [],
  min: [0, 0, 0],
  max: [0, 0, 0],
  valid: true,
  volume: 0,
  faceCount: 0,
  edgeCount: 0,
})

export function meshShape(oc: any, shape: any, solid = true): KernelResult {
  const owned: any[] = []
  const keep = <T>(obj: T): T => {
    owned.push(obj)
    return obj
  }
  try {
    const checker = keep(new oc.BRepCheck_Analyzer(shape, true))
    if (!checker.IsValid_2()) throw new Error('OCCT BRep 有效性检查未通过。')
    const props = keep(new oc.GProp_GProps_1())
    if (solid) oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false)
    const volume = solid ? props.Mass() : 0
    if (solid && (!Number.isFinite(volume) || volume <= 0)) throw new Error('OCCT 未生成有效实体。')
    keep(new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false))
    const meshes: FaceMesh[] = []
    const faces = keep(
      new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE),
    )
    while (faces.More()) {
      const current = faces.Current()
      const f = oc.TopoDS.Face_1(current)
      const location = new oc.TopLoc_Location_1()
      const handle = oc.BRep_Tool.Triangulation(f, location)
      const transform = location.Transformation()
      try {
        if (handle.IsNull()) throw new Error('OCCT 曲面网格为空。')
        const tri = handle.get()
        const vertices: number[] = []
        const indices: number[] = []
        for (let i = 1; i <= tri.NbNodes(); i++) {
          const p = tri.Node(i)
          try {
            p.Transform(transform)
            vertices.push(p.X(), p.Y(), p.Z())
          } finally {
            p.delete()
          }
        }
        const reversed = f.Orientation_1().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value
        for (let i = 1; i <= tri.NbTriangles(); i++) {
          const t = tri.Triangle(i)
          try {
            const ids = [t.Value(1) - 1, t.Value(2) - 1, t.Value(3) - 1]
            if (reversed) [ids[1], ids[2]] = [ids[2], ids[1]]
            indices.push(...ids)
          } finally {
            t.delete()
          }
        }
        const normals = Array(vertices.length).fill(0)
        for (let t = 0; t < indices.length; t += 3) {
          const ids = indices.slice(t, t + 3),
            [a, b, c] = ids.map(i => vertices.slice(i * 3, i * 3 + 3)),
            u = b.map((component, i) => component - a[i]),
            v = c.map((component, i) => component - a[i]),
            n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
          for (const id of ids) for (let axis = 0; axis < 3; axis++) normals[id * 3 + axis] += n[axis]
        }
        for (let i = 0; i < normals.length; i += 3) {
          const length = Math.hypot(...normals.slice(i, i + 3))
          if (length > 1e-12) for (let j = 0; j < 3; j++) normals[i + j] /= length
        }
        const normal = normals.slice(0, 3),
          surface = new oc.BRepAdaptor_Surface_2(f, true)
        try {
          meshes.push({
            vertices,
            indices,
            normal,
            normals,
            surface: analyticSurface(oc, surface, vertices, reversed),
            planar: surface.GetType().value === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value,
          })
        } finally {
          surface.delete()
        }
        // get() is a borrowed pointer owned by the Handle_Poly_Triangulation.
      } finally {
        transform.delete()
        handle.delete()
        location.delete()
        f.delete()
        current.delete()
      }
      faces.Next()
    }
    const lines: number[][] = []
    const uniqueEdges = new Set<string>()
    const edges = keep(
      new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE),
    )
    while (edges.More()) {
      const current = edges.Current()
      const edge = oc.TopoDS.Edge_1(current)
      const curve = new oc.BRepAdaptor_Curve_2(edge),
        key = String(edge.HashCode(2147483647))
      try {
        if (!uniqueEdges.has(key)) {
          uniqueEdges.add(key)
          const start = curve.FirstParameter(),
            end = curve.LastParameter(),
            linear = curve.GetType().value === oc.GeomAbs_CurveType.GeomAbs_Line.value,
            points: number[] = []
          const count = linear ? 1 : Math.min(512, Math.max(48, Math.ceil(Math.abs(end - start) * 16)))
          for (let i = 0; i <= count; i++) {
            const p = curve.Value(start + ((end - start) * i) / count)
            try {
              points.push(p.X(), p.Y(), p.Z())
            } finally {
              p.delete()
            }
          }
          lines.push(points)
        }
      } finally {
        curve.delete()
        edge.delete()
        current.delete()
      }
      edges.Next()
    }
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity]
    for (const mesh of meshes)
      for (let i = 0; i < mesh.vertices.length; i++) {
        const axis = i % 3
        min[axis] = Math.min(min[axis], mesh.vertices[i])
        max[axis] = Math.max(max[axis], mesh.vertices[i])
      }
    return {
      meshes: solid ? meshes : [],
      lines,
      min,
      max,
      valid: true,
      volume,
      faceCount: meshes.length,
      edgeCount: lines.length,
    }
  } finally {
    for (const obj of owned.reverse()) obj.delete()
  }
}
