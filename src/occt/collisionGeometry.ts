import { CadDocument, CoordinateSystem } from './model'
import { withBodies } from './engineeringKernel'
import { Vector3 } from 'three'

/** Native handles are scoped to a synchronous worker computation. */
export function nativeScope<T>(action: (keep: <H>(handle: H) => H) => T): T {
  const owned: any[] = []
  try {
    return action(<H>(handle: H): H => {
      owned.push(handle)
      return handle
    })
  } finally {
    for (const handle of owned.reverse()) handle.delete()
  }
}

export function withCollisionTemplates<T>(oc: any, d: CadDocument, action: (shapes: Map<number, any>) => T): T {
  return nativeScope(keep => {
    const shapes = new Map<number, any>()
    const visit = (index: number): T => {
      if (index === d.assembly!.parts.length) return action(shapes)
      const part = d.assembly!.parts[index]
      if (!d.assembly!.instances.some(i => i.productId === part.id)) return visit(index + 1)
      return withBodies(oc, part.document, bodies => {
        if (bodies.length) {
          let shape = bodies[0].shape
          for (const body of bodies) {
            requireSolid(oc, body.shape)
            if (body === bodies[0]) continue
            const union = keep(new oc.BRepAlgoAPI_Fuse_3(shape, body.shape))
            if (!union.IsDone()) throw new Error('防穿透检查无法合并零件实体。')
            shape = keep(union.Shape())
          }
          requireSolid(oc, shape)
          shapes.set(part.id, shape)
        }
        return visit(index + 1)
      })
    }
    return visit(0)
  })
}

export function requireSolid(oc: any, shape: any): void {
  nativeScope(keep => {
    const solids = keep(
        new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE),
      ),
      loose = keep(new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SOLID)),
      valid = keep(new oc.BRepCheck_Analyzer(shape, true))
    if (!solids.More() || loose.More() || !valid.IsValid_2())
      throw new Error('防穿透需要有效封闭实体；当前零件无法确认安全路径。')
  })
}

export function placeShape(oc: any, shape: any, c: CoordinateSystem, keep: <H>(handle: H) => H): any {
  const trsf = keep(new oc.gp_Trsf_1())
  trsf.SetValues(
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
  )
  const transform = keep(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true))
  if (!transform.IsDone()) throw new Error('防穿透无法变换零件实体。')
  return keep(transform.Shape())
}

export function overlapVolume(oc: any, first: any, second: any): number {
  return nativeScope(keep => {
    const common = keep(new oc.BRepAlgoAPI_Common_3(first, second))
    if (!common.IsDone()) throw new Error('路径实体求交失败，移动未提交。')
    const shape = keep(common.Shape())
    if (shape.IsNull()) throw new Error('路径实体求交未返回结果。')
    const props = keep(new oc.GProp_GProps_1())
    oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false)
    const volume = props.Mass()
    if (!Number.isFinite(volume) || volume < -1e-12) throw new Error('路径求交体积无效。')
    return Math.max(0, volume)
  })
}

export function shapeDistance(oc: any, first: any, second: any): { distance: number; points: number[][] } {
  return nativeScope(keep => {
    const tool = keep(new oc.BRepExtrema_DistShapeShape_1())
    tool.LoadS1(first)
    tool.LoadS2(second)
    tool.SetDeflection(1e-7)
    if (!tool.Perform() || !tool.IsDone() || !tool.NbSolution())
      throw new Error('OCCT 无法确认实体间距离，移动未提交。')
    const distance = tool.Value(),
      a = keep(tool.PointOnShape1(1)),
      b = keep(tool.PointOnShape2(1))
    if (!Number.isFinite(distance) || distance < 0) throw new Error('实体间距离无效。')
    return {
      distance,
      points: [
        [a.X(), a.Y(), a.Z()],
        [b.X(), b.Y(), b.Z()],
      ],
    }
  })
}

/** The initial solid plus sweeps of its boundary faces cover every point occupied during translation. */
export function translationSweepHits(oc: any, first: any, second: any, delta: Vector3, fraction: number): boolean {
  return nativeScope(keep => {
    const vector = delta.clone().multiplyScalar(fraction),
      v = keep(new oc.gp_Vec_4(vector.x, vector.y, vector.z)),
      faces = keep(new oc.TopExp_Explorer_2(first, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
    for (; faces.More(); faces.Next()) {
      const hit = nativeScope(retain => {
        const face = retain(oc.TopoDS.Face_1(retain(faces.Current()))),
          surface = retain(new oc.BRepAdaptor_Surface_2(face, true)),
          type = surface.GetType().value
        // Analytic tangent sweeps have no volume, including snug cylinders sliding along their axis.
        if (
          type === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value ||
          type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value
        ) {
          const native = retain(
              type === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value ? surface.Plane() : surface.Cylinder(),
            ),
            axis = retain(native.Axis()),
            direction = retain(axis.Direction()),
            normal = new Vector3(direction.X(), direction.Y(), direction.Z())
          if (
            type === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value
              ? Math.abs(normal.dot(vector)) < 1e-7
              : normal.clone().cross(vector).length() < 1e-7
          )
            return false
        }
        const prism = retain(new oc.BRepPrimAPI_MakePrism_1(face, v, false, true))
        if (!prism.IsDone()) throw new Error('OCCT 无法建立平移扫掠，移动未提交。')
        const swept = retain(prism.Shape())
        requireSolid(oc, swept)
        return overlapVolume(oc, swept, second) > 1e-12
      })
      if (hit) return true
    }
    return false
  })
}
