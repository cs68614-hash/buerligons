import { ScgClassType } from '@buerli.io/classcad'
import {
  ScgObject,
  ScgStructure,
  ScgGraphicPackage,
  ScgContainerType,
  ScgGraphicType,
  ScgMemberType,
} from '@classcad/api-js'
import { CadDocument, emptyAssembly, KernelResult, Mate, ModelView, rootView } from './model'
import { partMateFrames, relativeValues } from './assemblySolver'
import { engineeringStructure } from './engineeringStructure'

const identity = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
const member = (value: number, type = ScgMemberType.ID) => ({ type, value, expression: '', visible: 0 })
const real = (value: number) => member(value, ScgMemberType.REAL)
const point = (value: number[]) => ({
  type: ScgMemberType.POINT,
  value: { x: value[0], y: value[1], z: value[2] },
  expression: '',
  visible: 0,
})
const array = (members: any[]) => ({ type: ScgMemberType.ARRAY, members, expression: '', visible: 0 }) as any
const refs = (ids: number[]) => array(ids.map(id => member(id)))
const mateMember = (mate: Mate | null) =>
  array([
    refs(mate?.path || []),
    member(mate?.csys || 0),
    real(['X', '-X', 'Y', '-Y', 'Z', '-Z'].indexOf(mate?.flip || 'Z')),
    real(['0', '90', '180', '270'].indexOf(mate?.reorient || '0')),
  ])
const remapMember = (m: any, base: number): any => ({
  ...m,
  ...(m.type === ScgMemberType.ID && m.value ? { value: m.value + base } : {}),
  ...(m.members ? { members: m.members.map((child: any) => remapMember(child, base)) } : {}),
})
const remapObject = (obj: ScgObject, base: number): ScgObject => {
  const mapped = {
    ...obj,
    id: obj.id + base,
    parent: obj.parent ? obj.parent + base : 901,
    children: obj.children?.map(id => id + base),
    members: Object.fromEntries(Object.entries(obj.members || {}).map(([key, m]) => [key, remapMember(m, base)])),
  }
  for (const key of ['geometrySet', 'expressionSet', 'link'] as const) if (obj[key]) mapped[key] = obj[key]! + base
  for (const key of ['solids', 'geometryIdList', 'dimensions'] as const)
    if (obj[key]) mapped[key] = obj[key]!.map(id => id + base)
  return mapped
}

/** Implements the existing native editors' structure protocol; geometry comes from OCCT. */
export function toStructure(d: CadDocument, view: ModelView = rootView(), result?: KernelResult): ScgStructure {
  if (d.engineering)
    return engineeringStructure(
      toStructure({ ...d, version: 1, engineering: undefined, sketch: undefined, rectangle: null, extrusion: null }),
      d.engineering,
    )
  const tree: Record<number, ScgObject> = {}
  const add = (id: number, type: string, name: string, parent: number | null, children: number[] = []): ScgObject =>
    (tree[id] = {
      id,
      class: type,
      name,
      parent,
      children,
      flags: 0,
      visible: true,
      coordinateSystem: identity,
      members: {},
    })
  if (d.kind === 'assembly') {
    const a = d.assembly || emptyAssembly()
    // An assembly root is a product, not a Part with a different display name.
    // The native UI uses this class and currentProduct to select its assembly tools.
    const assembly = add(1, ScgClassType.CCAssemblyRoot, d.name, 902, [10, 15, 16, ...a.instances.map(i => i.id)])
    assembly.geometrySet = 10
    assembly.expressionSet = 16
    assembly.members = { solverState: real(0) }
    // Assembly roots render children; only Part products carry a solids array.
    add(10, ScgClassType.CCGeometrySet, 'Geometry', 1, [100])
    add(100, ScgClassType.CCWorkCSys, 'Origin', 10)
    add(
      15,
      ScgClassType.CCConstraintSet,
      'Constraints',
      1,
      a.constraints.map(c => c.id),
    )
    add(16, ScgClassType.CCExpressionSet, 'Expressions', 1)
    add(900, 'AllObjects', 'AllObjects', null, [901, 902]).members = {
      uncommitedObjectsIds: refs(a.constraints.filter(c => c.draft).map(c => c.id)),
    }
    add(
      901,
      ScgClassType.CCPartContainer,
      'PartContainer',
      900,
      a.parts.map(p => p.id),
    )
    add(902, ScgClassType.CCAssemblyContainer, 'AssemblyContainer', 900)
    for (const template of a.parts) {
      const offset = template.id - 1
      for (const obj of Object.values(toStructure(template.document).tree)) {
        const mapped = remapObject(obj, offset)
        tree[mapped.id] = mapped
      }
      for (const [handle, face] of Object.entries(result?.parts?.[template.id]?.mateFrames || {})) {
        const obj = add(offset + Number(handle), ScgClassType.CCWorkCSys, face.name, offset + 10)
        obj.coordinateSystem = face.frame
        obj.members = {
          occtFaceGraphicId: real(offset + face.graphicId),
          occtSurfaceKind: real(face.kind === 'plane' ? 1 : 2),
        }
      }
      for (const [localId, frame] of Object.entries(partMateFrames(template.document))) {
        if (Number(localId) === 100) continue
        const id = offset + Number(localId)
        add(
          id,
          ScgClassType.CCWorkCSys,
          ['Bottom', 'Top', 'Left', 'Right', 'Front', 'Back'][Number(localId) - 110],
          offset + 10,
        ).coordinateSystem = frame
        tree[offset + 10].children!.push(id)
      }
    }
    for (const instance of a.instances) {
      const obj = add(instance.id, ScgClassType.CCProductReference, instance.name, 1)
      obj.link = instance.productId
      obj.coordinateSystem = instance.csys
      obj.members = { productId: member(instance.productId) }
    }
    const presentMate = (mate: Mate | null) => {
      const instance = a.instances.find(i => i.id === mate?.path[0])
      const face =
        mate?.geometry &&
        instance &&
        Object.entries(result?.parts?.[instance.productId]?.mateFrames || {}).find(
          ([, frame]) => frame.key === mate.geometry!.key,
        )
      return mateMember(face && instance ? { ...mate!, csys: instance.productId - 1 + Number(face[0]) } : mate)
    }
    const poses = Object.fromEntries(a.instances.map(i => [i.id, i.csys]))
    for (const c of a.constraints) {
      const obj = add(c.id, (ScgClassType as any)['CC' + c.type + 'Constraint'], c.name, 15)
      obj.members = { firstRefMate: presentMate(c.mate1), secondRefMate: presentMate(c.mate2), solverState: real(0) }
      const values = relativeValues({ ...d, assembly: a }, c, poses, result?.parts)
      for (const axis of ['x', 'y', 'z'])
        for (const type of ['Offset', 'Rotation']) {
          const key = axis + type
          obj.members[key] = real(c.values[key] || 0)
          obj.members[key + 'Value'] = real(values[key] || 0)
          const limit = c.limits[key + 'Limits']
          obj.members[key + 'Limits'] = limit ? array([real(limit.min as any), real(limit.max as any)]) : array([])
        }
    }
    return {
      tree,
      root: 1,
      currentProduct: tree[view.productId] ? view.productId : 1,
      currentInstance: tree[view.instanceId] ? view.instanceId : 1,
      currentNode: tree[view.instanceId] ? view.instanceId : 1,
      testRoot: 0,
    }
  }
  const hasSketch = Boolean(d.sketch || d.rectangle)
  const part = add(1, ScgClassType.CCPart, d.name, null, [10, 11, 12, 13])
  part.geometrySet = 10
  part.solids = d.extrusion ? [1000] : []
  add(10, ScgClassType.CCGeometrySet, 'Geometry', 1, [
    100,
    101,
    102,
    103,
    104,
    105,
    106,
    ...(hasSketch ? [20] : []),
    ...(d.rectangle ? [22] : []),
    ...(d.extrusion ? [30] : []),
  ])
  add(11, ScgClassType.CCOperationSequence, 'Features', 1, [
    200,
    201,
    202,
    203,
    204,
    205,
    206,
    ...(hasSketch ? [21] : []),
    ...(d.extrusion ? [31] : []),
    99,
  ])
  add(12, ScgClassType.CCSolidSet, 'Bodies', 1, d.extrusion ? [1000] : [])
  add(13, ScgClassType.CCDimensionSet, 'Dimensions', 1, hasSketch ? [14] : [])
  if (hasSketch)
    add(14, ScgClassType.CCDimensionSet, 'Sketch dimensions', 13, d.rectangle ? [600, 601] : []).members = {
      owner: member(20),
    }
  const base = [
    [ScgClassType.CCWorkCSys, 'Origin'],
    [ScgClassType.CCWorkAxis, 'X'],
    [ScgClassType.CCWorkAxis, 'Y'],
    [ScgClassType.CCWorkAxis, 'Z'],
    [ScgClassType.CCWorkPlane, 'XY'],
    [ScgClassType.CCWorkPlane, 'YZ'],
    [ScgClassType.CCWorkPlane, 'XZ'],
  ]
  base.forEach(([type, name], i) => {
    const obj = add(100 + i, type, name, 10)
    const normal = i === 5 ? [1, 0, 0] : i === 6 ? [0, 1, 0] : [0, 0, 1]
    obj.members = {
      Type: real(i >= 4 ? i - 4 : 0),
      Size: real(1),
      curPosition: point([0, 0, 0]),
      Position: point([0, 0, 0]),
      Normal: point(normal),
      Direction: point(i === 1 ? [1, 0, 0] : i === 2 ? [0, 1, 0] : [0, 0, 1]),
      References: refs([]),
      Offset: real(0),
      Angle: real(0),
    }
    add(200 + i, ScgClassType.CCOperationReference, name, 11).members = { refObj: member(100 + i) }
  })
  add(90, ScgClassType.CCRollbackBar, 'End', 10)
  add(99, ScgClassType.CCRollbackBar, 'End', 11).members = { refObj: member(90) }
  if (hasSketch) {
    const r = d.rectangle
    add(20, ScgClassType.CCSketch, 'Sketch', 10, r ? [400, 401, 402, 403, 610, 611] : []).members = {
      planeReference: member(d.sketch?.planeId ?? 104),
      axisReference: member(0),
      originReference: member(0),
      axisIsX: real(1),
      planeInverted: real(0),
      axisInverted: real(0),
      boundingBox: array([
        point(r ? [r.x - 20, r.y - 20, 0] : [0, 0, 0]),
        point(r ? [r.x + r.width + 24, r.y + r.height + 12, 0] : [100, 100, 0]),
      ]),
      lgsState: real(1),
      isSolved: real(1),
    }
    add(21, ScgClassType.CCOperationReference, 'Sketch', 11).members = { refObj: member(20) }
    if (r) {
      const corners = [
        [r.x, r.y, 0],
        [r.x + r.width, r.y, 0],
        [r.x + r.width, r.y + r.height, 0],
        [r.x, r.y + r.height, 0],
      ]
      for (let i = 0; i < 4; i++) {
        add(400 + i, ScgClassType.CCLine, `Line ${i + 1}`, 20, [500 + i * 2, 501 + i * 2]).members = {
          isConstruction: real(0),
          lgsState: real(1),
        }
        add(500 + i * 2, ScgClassType.CCPoint, 'Start', 400 + i).members = { pos: point(corners[i]), lgsState: real(1) }
        add(501 + i * 2, ScgClassType.CCPoint, 'End', 400 + i).members = {
          pos: point(corners[(i + 1) % 4]),
          lgsState: real(1),
        }
      }
      add(22, ScgClassType.CCSketchRegion, 'Rectangle region', 10).members = {
        sketch: member(20),
        curves: refs([400, 401, 402, 403]),
        selected: refs([400, 401, 402, 403]),
      }
      for (let i = 0; i < 2; i++) {
        const value = i === 0 ? r.width : r.height
        const start = i === 0 ? corners[0] : corners[1],
          end = i === 0 ? corners[1] : corners[2]
        const dimPos = i === 0 ? [r.x + r.width / 2, r.y - 12, 0] : [r.x + r.width + 12, r.y + r.height / 2, 0]
        add(
          610 + i,
          i === 0 ? ScgClassType.CC2DHorizontalDistanceConstraint : ScgClassType.CC2DVerticalDistanceConstraint,
          i === 0 ? 'Width' : 'Height',
          20,
        ).members = {
          entities: refs(i === 0 ? [500, 501] : [502, 503]),
          value: real(value),
          userValue: real(value),
          lgsState: real(1),
          dimension: member(600 + i),
        }
        add(600 + i, ScgClassType.CCLinearDimension, i === 0 ? 'Width' : 'Height', 14).members = {
          master: member(610 + i),
          value: real(value),
          startPt: point(start),
          endPt: point(end),
          dimPt: point(dimPos),
          angle: real(i === 0 ? 0 : Math.PI / 2),
        }
      }
    }
  }
  if (d.extrusion) {
    add(30, ScgClassType.CCExtrusion, 'Extrusion', 10, [32]).members = {
      region: member(32),
      extrudeType: real(0),
      extrudeDir: point([0, 0, 1]),
      limit1: real(0),
      limit2: real(d.extrusion.depth),
      taperAngle: real(0),
      capEnds: real(1),
    }
    add(32, ScgClassType.CCSketchRegion, 'Region', 30).members = {
      sketch: member(20),
      selected: refs([22]),
      curves: refs([400, 401, 402, 403]),
    }
    add(31, ScgClassType.CCOperationReference, 'Extrusion', 11).members = { refObj: member(30) }
    add(1000, ScgClassType.CCSolid, 'Extrusion body', 12).geometryIdList = [1000]
  }
  return { tree, root: 1, currentProduct: 1, currentInstance: 1, currentNode: 1, testRoot: 0 }
}

export function toGraphic(d: CadDocument, result: KernelResult): ScgGraphicPackage {
  if (d.kind === 'assembly') {
    const containers = (d.assembly?.parts || []).flatMap(part => {
      const base = part.id - 1,
        geometry = result.parts?.[part.id]
      if (!geometry) return []
      return toGraphic(part.document, geometry).containers.map(container => ({
        ...container,
        id: container.id + base,
        owner: container.owner + base,
        meshes: container.meshes.map(mesh => ({
          ...mesh,
          id: mesh.id + base,
          properties: { ...mesh.properties, operationId: mesh.properties.operationId + base },
        })),
        lines: container.lines.map(line => ({
          ...line,
          id: line.id + base,
          pointIds: line.pointIds.map(id => id + base),
          properties: { ...line.properties, operationId: ((line.properties as any).operationId || 30) + base },
        })),
      }))
    })
    return { properties: { version: 1 }, containers }
  }
  if (result.bodies) {
    let meshId = 3000,
      lineId = 4000,
      pointId = 5000
    return {
      properties: { version: 1 },
      containers: [...result.bodies, ...(result.referenceBodies || [])].flatMap(body => {
        const graphic = toGraphic({ ...d, engineering: undefined, extrusion: { depth: 1 } }, body.geometry)
        return graphic.containers.map(container => ({
          ...container,
          id: body.id,
          owner: body.id,
          meshes: container.meshes.map(mesh => ({
            ...mesh,
            id: meshId++,
            properties: { ...mesh.properties, operationId: body.featureId },
          })),
          lines: container.lines.map(line => ({
            ...line,
            id: lineId++,
            pointIds: [pointId++, pointId++],
            properties: { ...line.properties, operationId: body.featureId },
          })),
        }))
      }),
    }
  }
  if (!d.extrusion) return { properties: { version: 1 }, containers: [] }
  const operationId = d.extrusion ? 30 : 20
  const material = { color: [203, 211, 219], opacity: 1 }
  return {
    properties: { version: 1 },
    containers: [
      {
        // The existing Product renderer displays BREP containers, including a wire-only BRep.
        id: 1000,
        owner: 1000,
        type: ScgContainerType.BREP,
        properties: { material, layer: '', min: result.min, max: result.max, chordHeightTol: 0.1, angleTol: 0.5 },
        meshes: result.meshes.map((mesh, i) => ({
          id: 3000 + i,
          vertices: mesh.vertices,
          normals: mesh.normals,
          indices: mesh.indices,
          loops: [],
          properties: {
            operationId,
            material,
            importId: '',
            importName: '',
            surface:
              mesh.surface?.kind === 'cylinder'
                ? {
                    type: ScgGraphicType.CYLINDER,
                    origin: mesh.surface.frame[0],
                    axis: mesh.surface.frame[3],
                    radius: mesh.surface.radius!,
                    height: mesh.surface.height!,
                  }
                : mesh.planar !== false
                ? {
                    type: ScgGraphicType.PLANE,
                    normal: mesh.surface?.frame[3] || mesh.normal,
                    pointOnPlane: mesh.surface?.frame[0] || mesh.vertices.slice(0, 3),
                  }
                : { type: ScgGraphicType.NURBSSURFACE },
          },
        })),
        lines: result.lines.map((points, i) => ({
          id: 4000 + i,
          points,
          pointIds: [5000 + i * 2, 5001 + i * 2],
          properties: { operationId, material: { color: [45, 50, 60], opacity: 1 }, importName: '' },
        })),
        vertices: [],
        edges: [],
        arcs: [],
        cones: [],
        coordinateSystems: [],
        namedPoints: [],
        labels: [],
      },
    ],
  }
}
