import { Matrix4, Quaternion, Vector3 } from 'three'
import { AnalyticSurface } from './model'

/** Read analytic BRep surfaces, never infer a hole axis from tessellation normals. */
export function analyticSurface(
  oc: any,
  surface: any,
  vertices: number[],
  reversed: boolean,
): AnalyticSurface | undefined {
  const type = surface.GetType().value,
    plane = type === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value,
    cylinder = type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value
  if (!plane && !cylinder) return
  const native = plane ? surface.Plane() : surface.Cylinder(),
    axis = native.Axis(),
    direction = axis.Direction(),
    location = axis.Location()
  try {
    const normal = new Vector3(direction.X(), direction.Y(), direction.Z()),
      origin = new Vector3(location.X(), location.Y(), location.Z()),
      center = new Vector3(),
      lower = [Infinity, Infinity, Infinity],
      upper = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < vertices.length; i++) {
      lower[i % 3] = Math.min(lower[i % 3], vertices[i])
      upper[i % 3] = Math.max(upper[i % 3], vertices[i])
    }
    center.fromArray(lower.map((v, i) => (v + upper[i]) / 2))
    if (plane) {
      if (reversed) normal.negate()
      center.addScaledVector(normal, origin.clone().sub(center).dot(normal))
    } else {
      // Axis direction is canonical, independent of a cut face's reversed orientation.
      const first = normal.toArray().find(v => Math.abs(v) > 1e-8)!
      if (first < 0) normal.negate()
      center.copy(origin.clone().addScaledVector(normal, center.sub(origin).dot(normal)))
    }
    const rotation = new Matrix4().makeRotationFromQuaternion(
        new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), normal),
      ),
      e = rotation.elements
    return {
      kind: plane ? 'plane' : 'cylinder',
      frame: [center.toArray(), [e[0], e[1], e[2]], [e[4], e[5], e[6]], normal.toArray()],
      ...(cylinder
        ? {
            radius: native.Radius(),
            height: upper.reduce((n, v, i) => n + Math.abs(normal.getComponent(i)) * (v - lower[i]), 0),
          }
        : {}),
    }
  } finally {
    location.delete()
    direction.delete()
    axis.delete()
    native.delete()
  }
}
