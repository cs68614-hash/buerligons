import { ScgClassType } from '@buerli.io/classcad'
import { ScgMemberType, ScgObject, ScgStructure } from '@classcad/api-js'
import { EngineeringModel, SketchFeature, visibleBodies, defaultBooleanTarget } from './engineeringModel'
import { entityPoints, getPoint, radius, sketchFrame } from './sketchSolver'

const member = (value: number, type = ScgMemberType.ID) => ({ type, value, expression: '', visible: 0 })
const real = (v: number) => member(v, ScgMemberType.REAL)
const point = (v: number[]) => ({
  type: ScgMemberType.POINT,
  value: { x: v[0], y: v[1], z: v[2] },
  expression: '',
  visible: 0,
})
const array = (members: any[]) => ({ type: ScgMemberType.ARRAY, members, expression: '', visible: 0 }) as any
const refs = (ids: number[]) => array(ids.map(id => member(id)))
const constraintClass: Record<string, string> = {
  FIXATION: 'CC2DFixationConstraint',
  COINCIDENT: 'CC2DCoincidentConstraint',
  HORIZONTAL: 'CC2DHorizontalConstraint',
  VERTICAL: 'CC2DVerticalConstraint',
  PARALLEL: 'CC2DParallelConstraint',
  PERPENDICULAR: 'CC2DPerpendicularConstraint',
  COLINEAR: 'CC2DColinearConstraint',
  CONCENTRIC: 'CC2DConcentricConstraint',
  MIDPOINT: 'CC2DMidpointConstraint',
  EQUAL_LENGTH: 'CC2DEqualLengthConstraint',
  EQUAL_RADIUS: 'CC2DEqualRadiusConstraint',
  TANGENT: 'CC2DTangentSketchConstraint',
  HORIZONTAL_DISTANCE: 'CC2DHorizontalDistanceConstraint',
  VERTICAL_DISTANCE: 'CC2DVerticalDistanceConstraint',
  OFFSET: 'CC2DOffsetConstraint',
  RADIUS: 'CC2DRadiusConstraint',
  DIAMETER: 'CC2DDiameterConstraint',
  ANGLE: 'CC2DAngleConstraint',
  ANGLEOX: 'CC2DAngleOXConstraint',
}

export function engineeringStructure(base: ScgStructure, m: EngineeringModel): ScgStructure {
  const tree = base.tree,
    add = (id: number, type: string, name: string, parent: number, children: number[] = []): ScgObject =>
      (tree[id] = {
        id,
        class: type,
        name,
        parent,
        children,
        flags: 0,
        visible: true,
        coordinateSystem: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        members: {},
      })
  const bodies = visibleBodies(m)
  tree[1].solids = bodies.map(f => f.bodyId)
  tree[1].expressionSet = 16
  add(16, ScgClassType.CCExpressionSet, 'Expressions', 1)
  add(15, 'AllObjects', 'AllObjects', 0).members = {
    uncommitedObjectsIds: refs(m.features.filter(f => 'draft' in f && f.draft).map(f => f.id)),
  }
  tree[10].children = [
    100,
    101,
    102,
    103,
    104,
    105,
    106,
    ...m.features.map(f => f.id),
    ...m.features.filter((f): f is SketchFeature => f.type === 'sketch').flatMap(s => s.regions.map(r => r.id)),
  ]
  tree[11].children = [200, 201, 202, 203, 204, 205, 206, ...m.features.map(f => f.opId), 99]
  tree[12].children = bodies.map(f => f.bodyId)
  tree[13].children = m.features.filter((f): f is SketchFeature => f.type === 'sketch').map(s => s.dimensionSetId)
  for (const f of m.features) {
    add(f.opId, ScgClassType.CCOperationReference, f.name, 11).members = { refObj: member(f.id) }
    if (f.type === 'sketch') {
      const s = f,
        positions = s.points.length
          ? s.points.map(p => [p.x, p.y, 0])
          : [
              [0, 0, 0],
              [100, 100, 0],
            ],
        min = [0, 1, 2].map(i => Math.min(...positions.map(p => p[i])) - 20),
        max = [0, 1, 2].map(i => Math.max(...positions.map(p => p[i])) + 24)
      const obj = add(s.id, ScgClassType.CCSketch, s.name, 10, [
        ...s.entities.map(e => e.id),
        ...s.constraints.map(c => c.id),
      ])
      obj.coordinateSystem = sketchFrame(s)
      obj.members = {
        planeReference: member(s.planeId),
        axisReference: member(0),
        originReference: member(0),
        axisIsX: real(1),
        planeInverted: real(0),
        axisInverted: real(0),
        boundingBox: array([point(min), point(max)]),
        lgsState: real(s.dof === 0 ? 17 : 1),
        isSolved: real(1),
        solverState: array([real(s.dof), real(s.residual), real(1)]),
      }
      add(
        s.dimensionSetId,
        ScgClassType.CCDimensionSet,
        s.name + ' dimensions',
        13,
        s.constraints.flatMap(c => (c.dimensionId ? [c.dimensionId] : [])),
      ).members = { owner: member(s.id) }
      const ownedPoints = new Set<number>()
      for (const e of s.entities) {
        const ids = entityPoints(s, e.id),
          names =
            e.type === 'circle'
              ? ['center']
              : e.type === 'line'
              ? ['startPoint', 'endPoint']
              : ['startPoint', 'endPoint', 'center']
        const curve = add(
          e.id,
          e.type === 'line' ? ScgClassType.CCLine : e.type === 'circle' ? ScgClassType.CCCircle : ScgClassType.CCArc,
          e.type === 'line' ? 'Line' : e.type === 'circle' ? 'Circle' : 'Arc',
          s.id,
          ids,
        )
        curve.members = {
          isConstruction: real(e.construction ? 1 : 0),
          lgsState: real(s.dof === 0 ? 17 : 1),
          ...(e.type !== 'line' ? { radius: real(radius(s, e)), bulge: real(e.clockwise ? -1 : 1) } : {}),
        }
        ids.forEach((id, i) => {
          const p = getPoint(s, id)
          add(id, ScgClassType.CCPoint, names[i], e.id).members = { pos: point([p.x, p.y, 0]), lgsState: real(1) }
          ownedPoints.add(id)
        })
      }
      for (const p of s.points.filter(candidatePoint => !ownedPoints.has(candidatePoint.id))) {
        add(p.id, ScgClassType.CCPoint, 'Point', s.id).members = { pos: point([p.x, p.y, 0]), lgsState: real(1) }
        obj.children!.push(p.id)
      }
      for (const r of s.regions) {
        const node = add(r.id, ScgClassType.CCSketchRegion, r.name, 10)
        node.coordinateSystem = sketchFrame(s)
        node.members = { sketch: member(s.id), curves: refs(r.curves), selected: refs(r.curves) }
      }
      for (const c of s.constraints) {
        const node = add(c.id, (ScgClassType as any)[constraintClass[c.type]], c.name, s.id)
        node.members = {
          entities: refs(c.entities),
          value: real(c.value ?? 0),
          userValue: real(c.value ?? 0),
          lgsState: real(1),
          dimension: member(c.dimensionId || 0),
        }
        if (!c.dimensionId) continue
        const radial = c.type === 'RADIUS' || c.type === 'DIAMETER',
          angular = c.type === 'ANGLE' || c.type === 'ANGLEOX',
          ids = c.entities.flatMap(id => entityPoints(s, id)),
          a = getPoint(s, ids[0]),
          b = getPoint(s, ids[1] ?? ids[0]),
          dimPos = c.position || [(a.x + b.x) / 2 + 12, (a.y + b.y) / 2 - 12, 0]
        const dim = add(
          c.dimensionId,
          radial
            ? c.type === 'DIAMETER'
              ? ScgClassType.CCDiameterDimension
              : ScgClassType.CCRadialDimension
            : angular
            ? ScgClassType.CCAngularDimension
            : ScgClassType.CCLinearDimension,
          c.name,
          s.dimensionSetId,
        )
        dim.members = {
          master: member(c.id),
          value: real(c.value!),
          dimPt: point(dimPos),
          startPt: point([a.x, a.y, 0]),
          endPt: point([b.x, b.y, 0]),
          angle: real(
            c.type === 'VERTICAL_DISTANCE' ? Math.PI / 2 : c.type === 'OFFSET' ? Math.atan2(b.y - a.y, b.x - a.x) : 0,
          ),
        }
        if (radial) {
          const e = s.entities.find(candidateEntity => candidateEntity.id === c.entities[0])!,
            center = getPoint(s, e.center!)
          dim.members.center = point([center.x, center.y, 0])
          dim.members.radius = real(radius(s, e))
        }
        if (angular) {
          const first = s.entities.find(e => e.id === c.entities[0])!,
            second = s.entities.find(e => e.id === c.entities[1]),
            p1 = getPoint(s, first.start!),
            p2 = getPoint(s, first.end!),
            q1 = second ? getPoint(s, second.start!) : p1,
            q2 = second ? getPoint(s, second.end!) : { x: p1.x + 10, y: p1.y },
            u = [p2.x - p1.x, p2.y - p1.y],
            v = [q2.x - q1.x, q2.y - q1.y],
            cross = u[0] * v[1] - u[1] * v[0],
            t = Math.abs(cross) > 1e-8 ? ((q1.x - p1.x) * v[1] - (q1.y - p1.y) * v[0]) / cross : 0,
            corner = [p1.x + t * u[0], p1.y + t * u[1], 0]
          Object.assign(dim.members, {
            cornerPt: point(corner),
            startPt: point([corner[0] + u[0], corner[1] + u[1], 0]),
            endPt: point([corner[0] + v[0], corner[1] + v[1], 0]),
            extendToCorner: real(1),
            ccw: real(1),
          })
        }
      }
    } else {
      const type =
        f.type === 'extrusion'
          ? ScgClassType.CCExtrusion
          : f.type === 'import'
          ? ScgClassType.CCImport
          : f.operation === 'SUBTRACTION'
          ? ScgClassType.CCSubtraction
          : f.operation === 'UNION'
          ? ScgClassType.CCUnion
          : ScgClassType.CCIntersection
      const obj = add(f.id, type, f.name, 10, [f.bodyId])
      if (f.type === 'extrusion') {
        const s = m.features.find(
          (candidateSketch): candidateSketch is SketchFeature =>
            candidateSketch.id === f.sketchId && candidateSketch.type === 'sketch',
        )!
        obj.members = {
          region: member(f.regionId),
          extrudeType: real(f.direction === 'UP' ? 0 : f.direction === 'DOWN' ? 1 : 2),
          extrudeDir: point(sketchFrame(s)[3]),
          limit1: real(0),
          limit2: real(f.depth),
          taperAngle: real(0),
          capEnds: real(1),
        }
        const region = add(f.regionId, ScgClassType.CCSketchRegion, 'Region', f.id)
        region.coordinateSystem = sketchFrame(s)
        region.members = {
          sketch: member(s.id),
          selected: refs(f.references),
          curves: refs(f.references.flatMap(id => s.regions.find(r => r.id === id)?.curves || [id])),
        }
      }
      if (f.type === 'boolean') {
        const defaults = defaultBooleanTarget(m),
          target = m.features.find(candidate => candidate.id === f.target)
        obj.members = {
          Body1: member(f.draft ? defaults.target : target && 'bodyId' in target ? target.bodyId : 0),
          Body2: refs(
            f.draft
              ? defaults.tools
              : f.tools.map(id => {
                  const t = m.features.find(candidateFeature => candidateFeature.id === id)!
                  return 'bodyId' in t ? t.bodyId : 0
                }),
          ),
        }
      }
      const solid = add(f.bodyId, ScgClassType.CCSolid, f.name + ' body', f.id)
      solid.geometryIdList = [f.bodyId]
      solid.visible = bodies.some(body => body.id === f.id)
    }
  }
  return base
}
