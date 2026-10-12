import { CadDocument, InterferenceReport, CoordinateSystem, validateDocument } from './model'
import { withBodies } from './engineeringKernel'
import { rebuild } from './kernel'
import { meshShape } from './geometry'
import { validateCSys } from './assemblyModel'

// Face/edge contact is not volumetric interference. Units are mm³.
export const interferenceVolumeTolerance = 1e-6

/** Analyses final BReps at solved instance poses; bounding boxes only reject distant pairs. */
export function checkInterference(
  oc: any,
  input: CadDocument,
  solvedPoses?: Record<number, CoordinateSystem>,
): InterferenceReport {
  const d = validateDocument(input)
  if (d.kind !== 'assembly' || !d.assembly) throw new Error('干涉检查仅用于装配。')
  if (!solvedPoses && d.assembly.constraints.some(c => c.draft))
    throw new Error('请先应用或关闭正在编辑的新配合，再检查干涉。')
  const a = d.assembly,
    // Interactive snapshots use the displayed solver output, including free-axis drives and previews.
    poses = solvedPoses
      ? Object.fromEntries(d.assembly.instances.map(i => [i.id, validateCSys(solvedPoses[i.id])]))
      : rebuild(oc, d).poses!,
    report: InterferenceReport = {
      overlaps: [],
      errors: [],
      ignoredInstances: [],
      totalPairs: (a.instances.length * (a.instances.length - 1)) / 2,
      checkedPairs: 0,
      broadPhaseSkipped: 0,
      volumeTolerance: interferenceVolumeTolerance,
    },
    templates = new Map<number, any>(),
    owned: any[] = [],
    keep = <T>(value: T): T => {
      owned.push(value)
      return value
    }
  const inspectSolid = (shape: any) => {
    const solids = keep(
        new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE),
      ),
      loose = keep(new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SOLID)),
      valid = keep(new oc.BRepCheck_Analyzer(shape, true))
    if (!solids.More() || loose.More() || !valid.IsValid_2())
      throw new Error('零件必须包含有效封闭实体；开放曲面不能完成体积干涉检查。')
  }
  const analyse = () => {
    const placed = a.instances.flatMap(instance => {
      const shape = templates.get(instance.productId)
      if (!shape) return []
      const c = poses[instance.id],
        trsf = keep(new oc.gp_Trsf_1())
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
      if (!transform.IsDone()) throw new Error('OCCT 无法变换零件实例。')
      const world = keep(transform.Shape()),
        box = keep(new oc.Bnd_Box_1())
      // Exact BRep bounds, including tolerance; not tessellated vertex bounds.
      oc.BRepBndLib.Add(world, box, false)
      const min = keep(box.CornerMin()),
        max = keep(box.CornerMax())
      return [{ instance, shape: world, min: [min.X(), min.Y(), min.Z()], max: [max.X(), max.Y(), max.Z()] }]
    })
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) {
        const first = placed[i],
          second = placed[j],
          ids: [number, number] = [first.instance.id, second.instance.id]
        if (first.min.some((value, axis) => value > second.max[axis] || second.min[axis] > first.max[axis])) {
          report.broadPhaseSkipped++
          report.checkedPairs++
          continue
        }
        // Release expensive boolean and mesh native handles after every pair.
        let operation: any, common: any, props: any, solids: any
        try {
          operation = new oc.BRepAlgoAPI_Common_3(first.shape, second.shape)
          if (!operation.IsDone()) throw new Error('OCCT 实体求交失败。')
          common = operation.Shape()
          if (common.IsNull()) throw new Error('OCCT 实体求交未返回结果。')
          solids = new oc.TopExp_Explorer_2(common, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
          if (solids.More()) {
            props = new oc.GProp_GProps_1()
            oc.BRepGProp.VolumeProperties_1(common, props, true, false, false)
            const volume = props.Mass()
            if (!Number.isFinite(volume) || volume < -interferenceVolumeTolerance) throw new Error('求交体积无效。')
            if (volume > interferenceVolumeTolerance) {
              const geometry = meshShape(oc, common, true)
              report.overlaps.push({
                id: ids.join(':'),
                instanceIds: ids,
                names: [first.instance.name, second.instance.name],
                volume,
                geometry,
              })
            }
          }
          report.checkedPairs++
        } catch (error) {
          report.errors.push({ instanceIds: ids, message: error instanceof Error ? error.message : String(error) })
        } finally {
          solids?.delete()
          props?.delete()
          common?.delete()
          operation?.delete()
        }
      }
  }
  const visit = (index: number): void => {
    if (index === a.parts.length) return analyse()
    const part = a.parts[index],
      instances = a.instances.filter(i => i.productId === part.id)
    if (!instances.length) return visit(index + 1)
    // Keep each template's native bodies alive through the pairwise analysis.
    withBodies(oc, part.document, bodies => {
      if (!bodies.length)
        report.ignoredInstances.push(...instances.map(i => ({ id: i.id, name: i.name, reason: '无实体' })))
      else {
        try {
          bodies.forEach(body => inspectSolid(body.shape))
          let shape = bodies[0].shape
          for (const body of bodies.slice(1)) {
            const union = keep(new oc.BRepAlgoAPI_Fuse_3(shape, body.shape))
            if (!union.IsDone()) throw new Error('零件多实体合并失败。')
            shape = keep(union.Shape())
          }
          inspectSolid(shape)
          templates.set(part.id, shape)
        } catch (error) {
          report.errors.push({
            instanceIds: instances.map(i => i.id),
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      visit(index + 1)
    })
  }
  try {
    visit(0)
    return report
  } finally {
    for (const value of owned.reverse()) value.delete()
  }
}
