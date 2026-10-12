import { CadDocument, KernelResult } from './model'
import { ensureEngineering, SketchFeature, visibleBodies } from './engineeringModel'
import { getEntity, getPoint, radius, sketchFrame, sketchLoops, SketchLoop } from './sketchSolver'
import { emptyGeometry, meshShape } from './geometry'
import { attachFaceFrames, nameEngineeringFaces } from './faceReferences'

// The pinned 1.1.1 Standard_CString binding is unreliable for long filenames.
// Use tested short internal MEMFS names; downloaded filenames never enter this API.
const bindingFile = (name: string): { argument: string; path: string } => ({ argument: name, path: '/' + name })

/** Only this module owns native BRep handles. Persisted features reference document objects, never pointers. */
export function withBodies<T>(
  oc: any,
  input: CadDocument,
  action: (
    bodies: { id: number; featureId: number; shape: any }[],
    references: { id: number; featureId: number; shape: any }[],
  ) => T,
): T {
  const d = structuredClone(input),
    m = ensureEngineering(d),
    owned: any[] = [],
    keep = <Owned>(o: Owned): Owned => {
      owned.push(o)
      return o
    },
    shapes = new Map<number, any>()
  const world = (s: SketchFeature, p: { x: number; y: number }) => {
    const frame = sketchFrame(s)
    return [0, 1, 2].map(i => frame[0][i] + p.x * frame[1][i] + p.y * frame[2][i])
  }
  const compound = (children: any[]) => {
    if (children.length === 1) return children[0]
    const shape = keep(new oc.TopoDS_Compound()),
      builder = keep(new oc.BRep_Builder())
    builder.MakeCompound(shape)
    children.forEach(child => builder.Add(shape, child))
    return shape
  }
  const wire = (s: SketchFeature, loop: SketchLoop) => {
    const builder = keep(new oc.BRepBuilderAPI_MakeWire_1())
    loop.curves.forEach((id, i) => {
      const e = getEntity(s, id)
      let edgeBuilder: any
      if (e.type === 'line')
        edgeBuilder = keep(
          new oc.BRepBuilderAPI_MakeEdge_3(
            keep(new oc.gp_Pnt_3(...world(s, getPoint(s, e.start!)))),
            keep(new oc.gp_Pnt_3(...world(s, getPoint(s, e.end!)))),
          ),
        )
      else {
        const center = keep(new oc.gp_Pnt_3(...world(s, getPoint(s, e.center!)))),
          frame = sketchFrame(s),
          axis = keep(new oc.gp_Ax2_2(center, keep(new oc.gp_Dir_4(...frame[3])), keep(new oc.gp_Dir_4(...frame[1])))),
          circle = keep(new oc.gp_Circ_2(axis, radius(s, e)))
        if (e.type === 'circle') edgeBuilder = keep(new oc.BRepBuilderAPI_MakeEdge_8(circle))
        else {
          const a = getPoint(s, e.start!),
            b = getPoint(s, e.end!),
            c = getPoint(s, e.center!)
          let start = Math.atan2(a.y - c.y, a.x - c.x),
            end = Math.atan2(b.y - c.y, b.x - c.x)
          if (e.clockwise) {
            ;[start, end] = [end, start]
          }
          while (end <= start) end += 2 * Math.PI
          edgeBuilder = keep(new oc.BRepBuilderAPI_MakeEdge_9(circle, start, end))
        }
      }
      if (!edgeBuilder.IsDone()) throw new Error('OCCT 无法构建草图曲线。')
      let edge = keep(edgeBuilder.Edge())
      if (loop.reversed[i] !== !!(e.type === 'arc' && e.clockwise)) edge = keep(oc.TopoDS.Edge_1(keep(edge.Reversed())))
      builder.Add_1(edge)
    })
    if (!builder.IsDone()) throw new Error('OCCT 无法构建闭合草图轮廓。')
    return keep(builder.Wire())
  }
  const samples = (s: SketchFeature, loop: SketchLoop): number[][] =>
    loop.curves.flatMap((id, i) => {
      const e = getEntity(s, id)
      if (e.type === 'line') {
        const p = getPoint(s, loop.reversed[i] ? e.end! : e.start!)
        return [[p.x, p.y]]
      }
      const c = getPoint(s, e.center!),
        r = radius(s, e)
      let start = 0,
        end = 2 * Math.PI
      if (e.type === 'arc') {
        const a = getPoint(s, e.start!),
          b = getPoint(s, e.end!)
        start = Math.atan2(a.y - c.y, a.x - c.x)
        end = Math.atan2(b.y - c.y, b.x - c.x)
        if (e.clockwise) {
          while (end >= start) end -= 2 * Math.PI
        } else while (end <= start) end += 2 * Math.PI
        if (loop.reversed[i]) [start, end] = [end, start]
      }
      return Array.from({ length: 48 }, (_, j) => {
        const t = start + ((end - start) * j) / 48
        return [c.x + r * Math.cos(t), c.y + r * Math.sin(t)]
      })
    })
  const contains = (polygon: number[][], p: number[]) => {
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++)
      if (
        polygon[i][1] > p[1] !== polygon[j][1] > p[1] &&
        p[0] <
          ((polygon[j][0] - polygon[i][0]) * (p[1] - polygon[i][1])) / (polygon[j][1] - polygon[i][1]) + polygon[i][0]
      )
        inside = !inside
    return inside
  }
  try {
    for (const f of m.features) {
      try {
        if (f.type === 'sketch') continue
        if (f.type === 'import' && !f.draft) {
          const file = bindingFile('in.stp'),
            path = file.path
          oc.FS.writeFile(path, f.step)
          try {
            const reader = keep(new oc.STEPControl_Reader_1())
            if (
              reader.ReadFile(file.argument).value !== oc.IFSelect_ReturnStatus.IFSelect_RetDone.value ||
              !reader.TransferRoots() ||
              reader.NbShapes() === 0
            )
              throw new Error('STEP 读取或实体转换失败。')
            shapes.set(f.id, keep(reader.OneShape()))
          } finally {
            oc.FS.unlink(path)
          }
        }
        if (f.type === 'extrusion') {
          const s = m.features.find(
              (candidateSketch): candidateSketch is SketchFeature =>
                candidateSketch.id === f.sketchId && candidateSketch.type === 'sketch',
            )!,
            selected = f.references.flatMap(id => s.regions.find(r => r.id === id)?.curves || [id]),
            loops = sketchLoops(s, selected)
          if (!loops.length || new Set(loops.flatMap(l => l.curves)).size !== new Set(selected).size)
            throw new Error('所选曲线必须组成完整闭合轮廓，不能包含开放或分支曲线。')
          const polygons = loops.map(l => samples(s, l)),
            parents = polygons.map((p, i) =>
              polygons.map((other, j) => (i !== j && contains(other, p[0]) ? j : -1)).filter(j => j >= 0),
            ),
            faces: any[] = []
          for (let i = 0; i < loops.length; i++) {
            if (parents[i].length % 2) continue
            const outer = wire(s, loops[i]),
              builder = keep(new oc.BRepBuilderAPI_MakeFace_15(outer, true))
            for (let j = 0; j < loops.length; j++)
              if (parents[j].length === parents[i].length + 1 && parents[j].includes(i)) {
                let inner = wire(s, loops[j])
                const area = (poly: number[][]) =>
                  poly.reduce((a, p, k) => {
                    const q = poly[(k + 1) % poly.length]
                    return a + p[0] * q[1] - q[0] * p[1]
                  }, 0)
                if (Math.sign(area(polygons[i])) === Math.sign(area(polygons[j])))
                  inner = keep(oc.TopoDS.Wire_1(keep(inner.Reversed())))
                builder.Add(inner)
              }
            if (!builder.IsDone()) throw new Error('无法构建含内轮廓的平面。')
            let face = keep(builder.Face())
            const normal = sketchFrame(s)[3],
              length = f.direction === 'DOWN' ? -f.depth : f.direction === 'BOTH' ? f.depth * 2 : f.depth
            if (f.direction === 'BOTH') {
              const trsf = keep(new oc.gp_Trsf_1())
              trsf.SetTranslation_1(keep(new oc.gp_Vec_4(...normal.map(v => -v * f.depth))))
              const transform = keep(new oc.BRepBuilderAPI_Transform_2(face, trsf, true))
              face = keep(oc.TopoDS.Face_1(keep(transform.Shape())))
            }
            const prism = keep(
              new oc.BRepPrimAPI_MakePrism_1(face, keep(new oc.gp_Vec_4(...normal.map(v => v * length))), false, true),
            )
            faces.push(keep(prism.Shape()))
          }
          shapes.set(f.id, compound(faces))
        }
        if (f.type === 'boolean' && !f.draft) {
          let shape = shapes.get(f.target)
          if (!shape) throw new Error('找不到布尔目标实体。')
          for (const id of f.tools) {
            const tool = shapes.get(id)
            if (!tool) throw new Error('找不到布尔工具实体。')
            const operation = keep(
              new oc[
                f.operation === 'SUBTRACTION'
                  ? 'BRepAlgoAPI_Cut_3'
                  : f.operation === 'UNION'
                  ? 'BRepAlgoAPI_Fuse_3'
                  : 'BRepAlgoAPI_Common_3'
              ](shape, tool),
            )
            if (!operation.IsDone()) throw new Error('OCCT 布尔计算失败。')
            const next = keep(operation.Shape())
            if (f.operation === 'SUBTRACTION') {
              const props = (at: any) => {
                const p = keep(new oc.GProp_GProps_1())
                oc.BRepGProp.VolumeProperties_1(at, p, true, false, false)
                return p.Mass()
              }
              if (props(shape) - props(next) < 1e-7) throw new Error('工具实体未切除材料，请检查孔位置、方向和深度。')
            }
            shape = next
          }
          shapes.set(f.id, shape)
        }
      } catch (error) {
        throw new Error(`特征「${f.name}」：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const visible = visibleBodies(m),
      body = (f: any) => ({ id: f.bodyId, featureId: f.id, shape: shapes.get(f.id) }),
      references = m.features.filter(f => shapes.has(f.id) && !visible.some(v => v.id === f.id))
    return action(visible.map(body), references.map(body))
  } finally {
    for (const o of owned.reverse()) o.delete()
  }
}

export function rebuildEngineering(oc: any, d: CadDocument): KernelResult {
  return withBodies(oc, d, (bodies, references) => {
    const result = emptyGeometry()
    result.bodies = []
    result.referenceBodies = references.map(body => ({
      id: body.id,
      featureId: body.featureId,
      geometry: meshShape(oc, body.shape, true),
    }))
    for (const body of bodies) {
      const geometry = meshShape(oc, body.shape, true)
      nameEngineeringFaces(d, body.featureId, geometry)
      result.bodies.push({ id: body.id, featureId: body.featureId, geometry })
      result.meshes.push(...geometry.meshes)
      result.lines.push(...geometry.lines)
      result.volume += geometry.volume
      result.faceCount += geometry.faceCount
      result.edgeCount += geometry.edgeCount
      if (result.bodies.length === 1) {
        result.min = geometry.min
        result.max = geometry.max
      } else
        for (let i = 0; i < 3; i++) {
          result.min[i] = Math.min(result.min[i], geometry.min[i])
          result.max[i] = Math.max(result.max[i], geometry.max[i])
        }
    }
    return attachFaceFrames(result)
  })
}

export function exportStep(oc: any, d: CadDocument): string {
  if (d.kind === 'assembly') throw new Error('本次 STEP 导出支持零件；装配结构交换将在子装配阶段接入。')
  return withBodies(oc, d, bodies => {
    if (!bodies.length) throw new Error('没有可导出的实体。')
    const writer = new oc.STEPControl_Writer_1(),
      file = bindingFile('out.stp'),
      path = file.path
    try {
      for (const body of bodies) {
        const checked = meshShape(oc, body.shape, true)
        if (!checked.valid) throw new Error('实体无效。')
        if (
          writer.Transfer(body.shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true).value !==
          oc.IFSelect_ReturnStatus.IFSelect_RetDone.value
        )
          throw new Error('STEP 转换失败。')
      }
      if (writer.Write(file.argument).value !== oc.IFSelect_ReturnStatus.IFSelect_RetDone.value)
        throw new Error('STEP 写入失败。')
      return oc.FS.readFile(path, { encoding: 'utf8' })
    } finally {
      writer.delete()
      if (oc.FS.analyzePath(path).exists) oc.FS.unlink(path)
    }
  })
}
