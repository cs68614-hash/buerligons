import { CadDocument, CoordinateSystem, GuardedMoveResult, MotionBlock, validateDocument } from './model'
import { rebuild, assemblyResult } from './kernel'
import { solveAssembly } from './assemblySolver'
import { rigidMotion } from './rigidMotion'
import {
  nativeScope,
  overlapVolume,
  placeShape,
  shapeDistance,
  translationSweepHits,
  withCollisionTemplates,
} from './collisionGeometry'

// A small stop gap, larger than the pinned OCCT distance/boolean numerical tolerance. Units: mm.
export const motionClearance = 1e-4
const collisionEpsilon = 1e-12

/** Certify swept translation or use conservative distance advancement along a rigid rotation arc. */
export function guardMove(oc: any, input: CadDocument, requested: CadDocument): GuardedMoveResult {
  const start = validateDocument(input),
    target = validateDocument(requested)
  if (!start.assembly || !target.assembly) throw new Error('防穿透仅用于装配移动。')
  if (
    JSON.stringify(start.assembly.parts) !== JSON.stringify(target.assembly.parts) ||
    JSON.stringify(start.assembly.constraints) !== JSON.stringify(target.assembly.constraints) ||
    start.assembly.instances.some(
      (i, n) => target.assembly!.instances[n]?.id !== i.id || target.assembly!.instances[n]?.productId !== i.productId,
    ) ||
    start.assembly.instances.length !== target.assembly.instances.length
  )
    throw new Error('移动期间不能改变零件模板、实例列表或约束。')
  const desired = rebuild(oc, target),
    instances = start.assembly.instances
  return withCollisionTemplates(oc, start, templates =>
    nativeScope(keep => {
      const bounds = new Map<number, { min: number[]; max: number[] }>()
      for (const [id, shape] of templates) {
        const box = keep(new oc.Bnd_Box_1())
        oc.BRepBndLib.Add(shape, box, false)
        const min = keep(box.CornerMin()),
          max = keep(box.CornerMax())
        bounds.set(id, { min: [min.X(), min.Y(), min.Z()], max: [max.X(), max.Y(), max.Z()] })
      }
      const motions = instances.map(i =>
          rigidMotion(i.csys, desired.poses![i.id], bounds.get(i.productId) || desired.parts![i.productId]),
        ),
        initial = instances.map(i =>
          templates.has(i.productId) ? placeShape(oc, templates.get(i.productId), i.csys, keep) : undefined,
        ),
        pairs: { i: number; j: number; speed: number }[] = []
      for (let i = 0; i < instances.length; i++)
        for (let j = i + 1; j < instances.length; j++) {
          if (!initial[i] || !initial[j] || motions[i].speed + motions[j].speed < collisionEpsilon) continue
          // Components sharing exactly the same world rigid motion retain their relative geometry.
          if (motions[i].delta.elements.every((v, n) => v === motions[j].delta.elements[n])) continue
          pairs.push({ i, j, speed: motions[i].speed + motions[j].speed })
        }
      let fraction = 1,
        reason: MotionBlock['reason'] = 'contact',
        stopped: typeof pairs = []
      const rotations: typeof pairs = []
      for (const pair of pairs) {
        const { i, j } = pair,
          distance = shapeDistance(oc, initial[i], initial[j]).distance
        if (overlapVolume(oc, initial[i], initial[j]) > collisionEpsilon) {
          fraction = 0
          reason = 'initialOverlap'
          stopped = [pair]
          break
        }
        if (motions[i].angle > 0 || motions[j].angle > 0) {
          rotations.push(pair)
          continue
        }
        const delta = motions[i].translation.clone().sub(motions[j].translation),
          length = delta.length()
        if (length < collisionEpsilon || distance > length + motionClearance) continue
        if (!translationSweepHits(oc, initial[i], initial[j], delta, fraction)) continue
        let low = 0,
          high = fraction
        // A monotone prefix sweep catches collisions even when both endpoint poses are clear.
        for (let iteration = 0; iteration < 50 && (high - low) * length > motionClearance / 4; iteration++) {
          const middle = (low + high) / 2
          if (translationSweepHits(oc, initial[i], initial[j], delta, middle)) high = middle
          else low = middle
        }
        const safe = Math.max(0, low - motionClearance / length)
        if (safe < fraction) {
          fraction = safe
          stopped = [pair]
        }
      }
      // Distance cannot close faster than the sum of maximum surface speeds for the two screw motions.
      // This is a path bound, not a fixed pose sampling interval.
      if (rotations.length && fraction > 0) {
        const limit = fraction
        let t = 0,
          completed = false,
          limitingPair: typeof pairs = []
        for (let iteration = 0; iteration < 256; iteration++) {
          const step = nativeScope(retain => {
            let advance = Infinity,
              closest: typeof pairs = []
            const placed = new Map<number, any>()
            const at = (n: number) => {
              if (!placed.has(n))
                placed.set(n, placeShape(oc, templates.get(instances[n].productId), motions[n].at(t), retain))
              return placed.get(n)
            }
            for (const pair of rotations) {
              const d = shapeDistance(oc, at(pair.i), at(pair.j)).distance,
                dt = d <= motionClearance * 2 ? 0 : (0.8 * (d - motionClearance - 1e-7)) / pair.speed
              if (dt < advance) {
                advance = dt
                closest = [pair]
              }
            }
            return { advance, closest }
          })
          if (step.advance >= limit - t) {
            t = limit
            completed = true
            break
          }
          if (step.advance <= 0) {
            stopped = step.closest
            completed = true
            break
          }
          t += step.advance
          limitingPair = step.closest
        }
        if (t < limit) {
          fraction = t
          reason = completed ? 'contact' : 'budget'
          if (!completed) stopped = limitingPair
        }
      }
      const poses: Record<number, CoordinateSystem> = Object.fromEntries(
          instances.map((i, n) => [i.id, motions[n].at(fraction)]),
        ),
        accepted = structuredClone(start)
      accepted.assembly!.instances.forEach(i => {
        i.csys = poses[i.id]
      })
      // Never re-project a clamped pose through a collision. It must already satisfy the original joints.
      const projected = solveAssembly(accepted, undefined, desired.parts)
      if (instances.some(i => poses[i.id].flat().some((v, n) => Math.abs(v - projected[i.id].flat()[n]) > 1e-12))) {
        fraction = 0
        reason = 'constraintPath'
        instances.forEach(i => {
          poses[i.id] = i.csys
        })
        accepted.assembly!.instances.forEach(i => {
          i.csys = poses[i.id]
        })
      }
      // Numerical/native failures must not turn a certified path into a penetrating committed pose.
      if (fraction > 0)
        nativeScope(retain => {
          const placed = initial.map((shape, n) =>
            shape ? placeShape(oc, templates.get(instances[n].productId), poses[instances[n].id], retain) : undefined,
          )
          for (const { i, j } of pairs)
            if (overlapVolume(oc, placed[i], placed[j]) > collisionEpsilon)
              throw new Error('最终位置存在体积干涉，移动未提交。')
        })
      const contacts = stopped.map(({ i, j }) =>
        nativeScope(retain => {
          const first = placeShape(oc, templates.get(instances[i].productId), poses[instances[i].id], retain),
            second = placeShape(oc, templates.get(instances[j].productId), poses[instances[j].id], retain)
          return {
            instanceIds: [instances[i].id, instances[j].id] as [number, number],
            names: [instances[i].name, instances[j].name] as [string, string],
            points: shapeDistance(oc, first, second).points,
          }
        }),
      )
      return {
        document: accepted,
        result: assemblyResult(accepted, desired.parts!, poses),
        block: fraction < 1 ? { fraction, reason, contacts, clearance: motionClearance } : undefined,
      }
    }),
  )
}
