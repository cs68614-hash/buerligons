const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

module.exports = function testBracket(oc, context) {
  const { nativeCommand, rebuild, toStructure, emptyDocument, parseDocument, serializeDocument, temp, root } = context
  const { exportStep } = require(path.join(temp, 'engineeringKernel.js'))
  const { importStepDocument } = require(path.join(temp, 'stepDocument.js'))
  const { solveSketch, getPoint } = require(path.join(temp, 'sketchSolver.js'))
  const near = (actual, expected, tol = 1e-6) =>
    assert.ok(Math.abs(actual - expected) < Math.max(1, Math.abs(expected)) * tol, `${actual} != ${expected}`)
  let document = emptyDocument(),
    last
  const command = (name, args) => {
    const edit = nativeCommand(name, args, document)
    document = parseDocument(serializeDocument(edit.document || document))
    last = edit.result
    rebuild(oc, document)
    return last
  }
  const sId = command('v1.sketch.create', { id: 1 })
  command('v1.sketch.setReferences', { id: sId, planeId: 104 })
  const corners = [
      [0, 0, 0],
      [80, 0, 0],
      [80, 15, 0],
      [20, 15, 0],
      [20, 60, 0],
      [0, 60, 0],
    ],
    lines = []
  for (let i = 0; i < corners.length; i++)
    lines.push(command('v1.sketch.line', { id: sId, startPos: corners[i], endPos: corners[(i + 1) % corners.length] }))
  let s = document.engineering.features[0]
  command('v1.sketch.constraint', { id: sId, type: 'FIXATION', geomIds: [s.entities[0].start] })
  for (const [index, type, value] of [
    [0, 'HORIZONTAL_DISTANCE', 80],
    [1, 'VERTICAL_DISTANCE', 15],
    [4, 'HORIZONTAL_DISTANCE', 20],
    [5, 'VERTICAL_DISTANCE', 60],
  ])
    command('v1.sketch.dimension', {
      id: sId,
      type,
      geomIds: [lines[index]],
      value,
      name: ['Width', 'Leg', 'Upright', 'Height'][[0, 1, 4, 5].indexOf(index)],
    })
  s = document.engineering.features[0]
  assert.equal(s.dof, 0)
  assert.equal(s.regions.length, 1)
  const baseId = command('v1.part.extrusion', {
    id: 1,
    references: s.regions.map(r => r.id),
    limit2: 20,
    name: 'Bracket base',
  })
  near(rebuild(oc, document).volume, 2100 * 20)
  const holeSketch = command('v1.sketch.create', { id: 1 })
  command('v1.sketch.setReferences', { id: holeSketch, planeId: 104 })
  const holes = []
  for (const center of [
    [50, 7.5, 0],
    [10, 40, 0],
  ]) {
    const id = command('v1.sketch.circle', { id: holeSketch, centerPos: center, radius: 3 })
    holes.push(id)
    const s = document.engineering.features.find(s => s.id === holeSketch),
      e = s.entities.find(e => e.id === id)
    command('v1.sketch.constraint', { id: holeSketch, type: 'FIXATION', geomIds: [e.center] })
  }
  const holeTool = command('v1.part.extrusion', { id: 1, references: holes, limit2: 20, name: 'Hole tool' })
  const cut = command('v1.part.boolean', {
    id: 1,
    type: 'SUBTRACTION',
    target: baseId,
    tools: [holeTool],
    name: 'Mounting holes',
  })
  let result = rebuild(oc, document)
  assert.equal(result.bodies.length, 1)
  assert.equal(result.bodies[0].featureId, cut)
  near(result.volume, (2100 - 2 * Math.PI * 9) * 20)
  assert.equal(result.meshes.filter(m => m.planar === false).length, 2)
  const tree = toStructure(document).tree
  assert.equal(tree[result.bodies[0].id].parent, cut, 'Native Boolean selects solids by their feature parent')
  assert.equal(tree[cut].members.Body1.value, document.engineering.features.find(f => f.id === baseId).bodyId)
  const before = parseDocument(serializeDocument(document)),
    sourceId = document.engineering.documentId,
    sketchUid = document.engineering.features[0].uid
  const width = document.engineering.features[0].constraints.find(c => c.name === 'Width')
  command('v1.sketch.updateDimension', { id: width.dimensionId, value: 100 })
  near(rebuild(oc, document).volume, (2400 - 2 * Math.PI * 9) * 20)
  assert.equal(document.engineering.documentId, sourceId)
  assert.equal(document.engineering.features[0].uid, sketchUid)
  const hole = document.engineering.features.find(f => f.id === holeSketch).constraints.find(c => c.type === 'DIAMETER')
  command('v1.sketch.updateDimension', { id: hole.dimensionId, value: 8 })
  near(rebuild(oc, document).volume, (2400 - Math.PI * (16 + 9)) * 20)
  const reopened = parseDocument(serializeDocument(document))
  assert.deepEqual(reopened, document)
  near(rebuild(oc, reopened).volume, rebuild(oc, document).volume)
  const step = exportStep(oc, document)
  assert.ok(step.startsWith('ISO-10303-21;'))
  assert.ok(step.includes('MANIFOLD_SOLID_BREP'))
  const imported = importStepDocument('带孔支架.step', step),
    again = rebuild(oc, parseDocument(serializeDocument(imported)))
  near(again.volume, rebuild(oc, document).volume)
  assert.equal(again.faceCount, rebuild(oc, document).faceCount)
  assert.equal(
    imported.engineering.features[0].type,
    'import',
    'STEP must not invent an editable source feature history',
  )
  const assembly = nativeCommand('v1.assembly.create', { name: 'Imported bracket' }, emptyDocument()).document
  const loaded = nativeCommand(
    'v1.assembly.loadProduct',
    { format: 'STP', data: new TextEncoder().encode(step) },
    assembly,
  ).document
  assert.equal(loaded.assembly.parts[0].document.engineering.features[0].type, 'import')
  const oversized = nativeCommand('v1.sketch.updateDimension', { id: hole.dimensionId, value: 200 }, document).document
  assert.throws(() =>
    rebuild(
      oc,
      nativeCommand('v1.part.updateExtrusion', { id: holeTool, references: [holes[0]], limit2: 20 }, oversized)
        .document,
    ),
  )
  assert.throws(() => rebuild(oc, importStepDocument('bad.step', 'ISO-10303-21;\nnot step')))
  assert.throws(() =>
    parseDocument(JSON.stringify({ ...document, engineering: { ...document.engineering, nextId: 700 } })),
  )
  assert.throws(() =>
    nativeCommand(
      'v1.sketch.constraint',
      { id: sId, type: 'FIXATION', geomIds: [lines[0]], name: 'Conflicting fixed line' },
      nativeCommand('v1.sketch.updateDimension', { id: width.dimensionId, value: 0 }, before).document,
    ),
  )
  // A conflicting fixed origin and distance must be rejected, not silently marked as solved.
  const conflict = structuredClone(before.engineering.features[0])
  const fixed = conflict.constraints.find(c => c.type === 'FIXATION')
  fixed.fixed = [999, 999]
  assert.throws(() =>
    solveSketch({
      ...conflict,
      constraints: [...conflict.constraints, { ...fixed, id: 2890, uid: 'test-conflict', fixed: [0, 0] }],
    }),
  )
  // Curved profiles: a semicircle made by a real arc and line, plus a nested circular hole.
  let arcDoc = emptyDocument()
  const edit = (name, args) => {
    const e = nativeCommand(name, args, arcDoc)
    arcDoc = e.document || arcDoc
    return e.result
  }
  const arcSketch = edit('v1.sketch.create', { id: 1 })
  edit('v1.sketch.setReferences', { id: arcSketch, planeId: 104 })
  edit('v1.sketch.arcBy3Points', { id: arcSketch, startPos: [10, 0, 0], midPos: [0, 10, 0], endPos: [-10, 0, 0] })
  edit('v1.sketch.line', { id: arcSketch, startPos: [-10, 0, 0], endPos: [10, 0, 0] })
  edit('v1.part.extrusion', { id: 1, limit2: 5 })
  near(rebuild(oc, arcDoc).volume, ((Math.PI * 100) / 2) * 5)
  let ring = emptyDocument()
  const change = (name, args) => {
    const e = nativeCommand(name, args, ring)
    ring = e.document || ring
    return e.result
  }
  const ringSketch = change('v1.sketch.create', { id: 1 })
  change('v1.sketch.setReferences', { id: ringSketch, planeId: 105 })
  change('v1.sketch.circle', { id: ringSketch, centerPos: [0, 0, 0], radius: 10 })
  change('v1.sketch.circle', { id: ringSketch, centerPos: [0, 0, 0], radius: 4 })
  change('v1.part.extrusion', { id: 1, limit2: 5, type: 'BOTH' })
  near(rebuild(oc, ring).volume, Math.PI * (100 - 16) * 10)
  const height = ring.engineering.features.find(f => f.type === 'extrusion')
  assert.equal(height.direction, 'BOTH')
  const circles = ring.engineering.features[0].entities
  change('v1.sketch.updateGeometry', { id: ringSketch, circles: [{ id: circles[0].id, radius: 11 }] })
  near(rebuild(oc, ring).volume, Math.PI * (121 - 16) * 10)
  change('v1.sketch.constraint', { id: ringSketch, type: 'FIXATION', geomIds: [circles[0].id] })
  assert.throws(() => nativeCommand('v1.sketch.updateGeometry', {
    id: ringSketch, circles: [{ id: circles[0].id, radius: 12 }],
  }, ring), /约束|收敛/)
  const grouped = change('v1.sketch.sketchRegion', { id: ringSketch, name: 'Annulus', geomIds: circles.map(c => c.id) })
  change('v1.sketch.updateSketchRegion', { regions: [{ id: grouped, geomIds: circles.map(c => c.id) }] })
  assert.equal(ring.engineering.features[0].regions.find(r => r.id === grouped).name, 'Annulus')
  const previewId = change('v1.part.createUncommitedObject', { id: 1, type: 'CC_Extrusion' })
  assert.ok(toStructure(ring).tree[15].members.uncommitedObjectsIds.members.some(m => m.value === previewId))
  change('v1.part.updateExtrusion', { id: previewId, limit2: 20, type: 'UP' })
  assert.equal(toStructure(ring).tree[15].members.uncommitedObjectsIds.members.length, 0)
  const heapBefore = oc.HEAPU8.length
  for (let i = 0; i < 20; i++) near(rebuild(oc, document).volume, rebuild(oc, reopened).volume)
  assert.equal(oc.HEAPU8.length, heapBefore, 'Repeated bracket rebuild leaked the WASM heap')
  if (process.env.UPDATE_OCCT_EXAMPLES === '1') {
    fs.writeFileSync(path.join(root, 'examples/bracket.occt.json'), serializeDocument(before) + '\n')
    fs.writeFileSync(path.join(root, 'examples/bracket.step'), exportStep(oc, before))
  }
  console.log(
    'PASS: constrained L-profile, two real through holes, width/diameter rebuild, stable document/feature identity, JSON and STEP roundtrip, native body references, STEP assembly import, conflict rejection, curved/nested profiles, repeated rebuild',
  )
}
