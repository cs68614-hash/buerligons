import { Matrix4, Quaternion, Vector3 } from 'three'
import { CoordinateSystem, KernelResult } from './model'
import { csysMatrix, matrixCSys } from './assemblySolver'

/** Constant-axis screw motion follows a pivot rotation, rather than cutting across its arc along a chord. */
export function rigidMotion(
  start: CoordinateSystem,
  end: CoordinateSystem,
  geometry: Pick<KernelResult, 'min' | 'max'>,
) {
  const initial = csysMatrix(start),
    delta = csysMatrix(end).multiply(initial.clone().invert()),
    rotation = new Quaternion().setFromRotationMatrix(delta).normalize()
  if (rotation.w < 0) rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w)
  // Canonicalize solver roundoff to an actual translation before checking/publishing it.
  // The accepted orientation is the original orientation, never an unchecked tiny end rotation.
  const extent = Math.hypot(...[0, 1, 2].map(i => Math.max(Math.abs(geometry.min[i]), Math.abs(geometry.max[i])))),
    roundoffAngle = 2 * Math.atan2(Math.hypot(rotation.x, rotation.y, rotation.z), rotation.w),
    effectiveEnd = structuredClone(end)
  if (roundoffAngle * extent <= 1e-7) {
    effectiveEnd.splice(1, 3, ...structuredClone(start.slice(1)))
    rotation.identity()
    delta.makeTranslation(...(end[0].map((v, i) => v - start[0][i]) as [number, number, number]))
  }
  const sin = Math.hypot(rotation.x, rotation.y, rotation.z),
    angle = 2 * Math.atan2(sin, rotation.w),
    translation = new Vector3().setFromMatrixPosition(delta),
    axis = sin > 0 ? new Vector3(rotation.x, rotation.y, rotation.z).divideScalar(sin) : new Vector3(0, 0, 1),
    axial = axis.clone().multiplyScalar(translation.dot(axis)),
    pivot = new Vector3()
  if (angle > 0) {
    const perpendicular = translation.clone().sub(axial)
    pivot
      .copy(perpendicular)
      .multiplyScalar(0.5)
      .addScaledVector(axis.clone().cross(perpendicular), 0.5 / Math.tan(angle / 2))
  }
  let radius = 0
  if (angle > 0)
    for (let corner = 0; corner < 8; corner++) {
      const p = new Vector3(...[0, 1, 2].map(i => (corner & (1 << i) ? geometry.max[i] : geometry.min[i])))
        .applyMatrix4(initial)
        .sub(pivot)
      radius = Math.max(radius, p.addScaledVector(axis, -p.dot(axis)).length())
    }
  const speed = angle > 0 ? axial.length() + angle * radius : translation.length()
  return {
    delta,
    translation,
    angle,
    speed,
    at: (t: number): CoordinateSystem => {
      if (t === 0) return structuredClone(start)
      if (t === 1) return structuredClone(effectiveEnd)
      const transform = new Matrix4()
      if (angle > 0) {
        transform.makeRotationAxis(axis, angle * t)
        // Stable even for tiny angles: avoid subtracting two far-away pivot coordinates.
        const perpendicular = translation.clone().sub(axial),
          theta = angle * t,
          oneMinusCos = 2 * Math.sin(theta / 2) ** 2,
          cot = 1 / Math.tan(angle / 2)
        transform.setPosition(
          perpendicular
            .clone()
            .multiplyScalar(0.5 * (oneMinusCos + cot * Math.sin(theta)))
            .addScaledVector(axis.clone().cross(perpendicular), 0.5 * (cot * oneMinusCos - Math.sin(theta)))
            .addScaledVector(axial, t),
        )
      } else transform.setPosition(translation.clone().multiplyScalar(t))
      return matrixCSys(transform.multiply(initial))
    },
  }
}
