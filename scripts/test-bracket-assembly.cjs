const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

module.exports = function testBracketAssembly(oc, context) {
  const { nativeCommand, rebuild, toStructure, emptyDocument, parseDocument, serializeDocument, temp, root } = context
  const { csysMatrix, mateWorld, relativeValues } = require(path.join(temp, 'assemblySolver.js'))
  const { toGraphic } = require(path.join(temp, 'adapter.js'))
  const { importStepDocument } = require(path.join(temp, 'stepDocument.js'))
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} != ${b}`)
  let pin = emptyDocument()
  pin.name = 'Locating pin'
  const feature = (name, args) => {
    const edit = nativeCommand(name, args, pin)
    pin = parseDocument(serializeDocument(edit.document))
    rebuild(oc, pin)
    return edit.result
  }
  const sketch = feature('v1.sketch.create', { id: 1 })
  feature('v1.sketch.setReferences', { id: sketch, planeId: 104 })
  const circle = feature('v1.sketch.circle', { id: sketch, centerPos: [0, 0, 0], radius: 3 })
  const shaft = feature('v1.part.extrusion', { id: 1, references: [circle], type: 'DOWN', limit2: 20, name: 'Pin shaft' })
  const headSketch = feature('v1.sketch.create', { id: 1 })
  feature('v1.sketch.setReferences', { id: headSketch, planeId: 104 })
  const headCircle = feature('v1.sketch.circle', { id: headSketch, centerPos: [0, 0, 0], radius: 6 })
  const head = feature('v1.part.extrusion', { id: 1, references: [headCircle], limit2: 4, name: 'Pin head' })
  feature('v1.part.boolean', { id: 1, type: 'UNION', target: shaft, tools: [head], name: 'Headed pin' })
  const bracket = parseDocument(fs.readFileSync(path.join(root, 'examples/bracket.occt.json'), 'utf8'))
  const bracketGeometry = rebuild(oc, bracket)
  assert.equal(Object.values(bracketGeometry.mateFrames).filter(f => f.kind === 'cylinder').length, 2)
  assert.equal(Object.values(bracketGeometry.mateFrames).filter(f => f.kind === 'plane').length, 8)
  const pinGeometry = rebuild(oc, pin)
  assert.equal(Object.values(pinGeometry.mateFrames).filter(f => f.kind === 'cylinder').length, 2)
  const stepPart = importStepDocument('STEP bracket', fs.readFileSync(path.join(root, 'examples/bracket.step'), 'utf8'))
  const stepFrames = rebuild(oc, stepPart).mateFrames
  assert.equal(Object.values(stepFrames).filter(f => f.kind === 'cylinder').length, 2)
  assert.deepEqual(rebuild(oc, parseDocument(serializeDocument(stepPart))).mateFrames, stepFrames)

  let document = nativeCommand('v1.assembly.create', { name: 'Bracket and locating pin' }, emptyDocument()).document
  let geometry = rebuild(oc, document)
  const command = (name, args, view) => {
    const edit = nativeCommand(name, args, document, view, geometry)
    const next = parseDocument(serializeDocument(edit.document || document))
    const built = rebuild(oc, next, edit.drive)
    next.assembly.instances.forEach(i => { i.csys = built.poses[i.id] })
    document = next
    geometry = built
    return edit.result
  }
  const bracketTemplate = command('v1.assembly.loadProduct', { format: 'OCCT_JSON', data: serializeDocument(bracket) }).id
  const pinTemplate = command('v1.assembly.loadProduct', { format: 'OCCT_JSON', data: serializeDocument(pin) }).id
  const bracketInstance = command('v1.assembly.instance', { ownerId: 1, productId: bracketTemplate })
  const pinInstance = command('v1.assembly.instance', { ownerId: 1, productId: pinTemplate, transformation: [[110, 70, 40], [1, 0, 0], [0, 1, 0]] })
  const unconstrained = serializeDocument(document)
  command('v1.assembly.fastenedOrigin', { id: 1, mate1: { path: [bracketInstance], csys: bracketTemplate + 99 } })
  const pick = (template, instance, predicate, flip = 'Z') => {
    const frames = Object.entries(geometry.parts[template].mateFrames).filter(([, f]) => predicate(f))
    assert.equal(frames.length, 1, 'Pick must identify a unique real analytic face')
    return { path: [instance], csys: template - 1 + Number(frames[0][0]), flip }
  }
  const hole = pick(bracketTemplate, bracketInstance, f => f.kind === 'cylinder' && Math.abs(f.frame[0][0] - 50) < 1e-5)
  const pinAxis = pick(pinTemplate, pinInstance, f => f.kind === 'cylinder' && f.radius === 3)
  const coaxialId = command('v1.assembly.cylindrical', { id: 1, mate1: hole, mate2: pinAxis })
  let coaxial = document.assembly.constraints.find(c => c.id === coaxialId)
  assert.ok(coaxial.mate1.geometry.key.includes(bracket.engineering.features.at(-1).uid))
  const relation = relativeValues(document, coaxial, geometry.poses, geometry.parts)
  for (const name of ['xOffset', 'yOffset', 'xRotation', 'yRotation']) near(relation[name], 0)
  const top = pick(bracketTemplate, bracketInstance, f => f.kind === 'plane' && f.frame[3][2] > .99 && Math.abs(f.frame[0][2] - 20) < 1e-5)
  const shoulder = pick(pinTemplate, pinInstance, f => f.kind === 'plane' && f.frame[3][2] < -.99 && Math.abs(f.frame[0][2]) < 1e-5, '-Z')
  const contactId = command('v1.assembly.planar', { id: 1, mate1: top, mate2: shoulder })
  const check = () => {
    const c = document.assembly.constraints.find(v => v.id === coaxialId)
    const axis1 = mateWorld(document, c.mate1, geometry.poses, geometry.parts)
    const axis2 = mateWorld(document, c.mate2, geometry.poses, geometry.parts)
    const relative = axis1.invert().multiply(axis2).elements
    near(relative[12], 0); near(relative[13], 0); near(relative[8], 0); near(relative[9], 0); near(relative[10], 1)
    const contact = document.assembly.constraints.find(v => v.id === contactId)
    const values = relativeValues(document, contact, geometry.poses, geometry.parts)
    near(values.zOffset, 0); near(values.xRotation, 0); near(values.yRotation, 0)
    const position = csysMatrix(document.assembly.instances.find(i => i.id === pinInstance).csys).elements
    near(position[12], 50); near(position[13], 7.5)
  }
  check()
  const structure = toStructure(document, undefined, geometry)
  const frameNode = structure.tree[coaxial.mate1.csys]
  assert.equal(frameNode.members.occtSurfaceKind.value, 2)
  const graphic = toGraphic(document, geometry)
  const faceGraphic = graphic.containers.flatMap(c => c.meshes).find(m => m.id === frameNode.members.occtFaceGraphicId.value)
  assert.equal(faceGraphic.properties.surface.type, 'cylinder')
  assert.equal(faceGraphic.properties.surface.radius, 3)
  const finished = serializeDocument(document)
  document = parseDocument(finished); geometry = rebuild(oc, document); check()
  const keys = document.assembly.constraints.flatMap(c => [c.mate1?.geometry?.key, c.mate2?.geometry?.key]).filter(Boolean)
  const width = bracket.engineering.features[0].constraints.find(c => c.name === 'Width')
  command('v1.sketch.updateDimension', { id: bracketTemplate - 1 + width.dimensionId, value: 100 }, { productId: bracketTemplate, instanceId: bracketInstance })
  const diameter = bracket.engineering.features.find(f => f.type === 'sketch' && f.id !== 20).constraints.find(c => c.type === 'DIAMETER')
  command('v1.sketch.updateDimension', { id: bracketTemplate - 1 + diameter.dimensionId, value: 8 }, { productId: bracketTemplate, instanceId: bracketInstance })
  command('v1.part.updateExtrusion', { id: bracketTemplate - 1 + 30, limit2: 15 }, { productId: bracketTemplate, instanceId: bracketInstance })
  check()
  near(document.assembly.instances.find(i => i.id === pinInstance).csys[0][2], 15)
  assert.deepEqual(document.assembly.constraints.flatMap(c => [c.mate1?.geometry?.key, c.mate2?.geometry?.key]).filter(Boolean), keys)
  const moved = parseDocument(serializeDocument(document))
  const movedPart = moved.assembly.parts.find(p => p.id === bracketTemplate).document
  const movedSketch = movedPart.engineering.features.find(f => f.id === 740)
  const selectedCircle = movedSketch.entities[0]
  const center = movedSketch.points.find(p => p.id === selectedCircle.center)
  center.x = 55; center.y = 9
  movedSketch.constraints.find(c => c.type === 'FIXATION' && c.entities.includes(center.id)).fixed = [55, 9]
  movedSketch.entities.reverse()
  movedPart.engineering.features.find(f => f.id === 755).references.reverse()
  const movedGeometry = rebuild(oc, parseDocument(serializeDocument(moved)))
  near(movedGeometry.poses[pinInstance][0][0], 55); near(movedGeometry.poses[pinInstance][0][1], 9)
  near(movedGeometry.poses[pinInstance][0][2], 15)
  const remapped = toStructure(moved, undefined, movedGeometry)
  const ref = remapped.tree[coaxialId].members.firstRefMate.members[1].value
  assert.ok(Math.abs(remapped.tree[ref].coordinateSystem[0][0] - 55) < 1e-5, 'Native mate must resolve semantic references after face reordering')
  const removed = parseDocument(serializeDocument(document))
  const removedPart = removed.assembly.parts.find(p => p.id === bracketTemplate).document
  const removedSketch = removedPart.engineering.features.find(f => f.id === 740)
  const removedCircle = removedSketch.entities.shift()
  removedSketch.points = removedSketch.points.filter(p => p.id !== removedCircle.center)
  removedSketch.constraints = removedSketch.constraints.filter(c => !c.entities.includes(removedCircle.id) && !c.entities.includes(removedCircle.center))
  removedSketch.regions = removedSketch.regions.filter(r => !r.curves.includes(removedCircle.id))
  removedPart.engineering.features.find(f => f.id === 755).references = [removedSketch.entities[0].id]
  assert.throws(() => rebuild(oc, removed), /配合面/)
  const legacy = { ...emptyDocument(), rectangle: { x: 0, y: 0, width: 40, height: 30 }, extrusion: { depth: 10 } }
  assert.equal(Object.values(rebuild(oc, legacy).mateFrames).length, 6)
  const uiFile = path.join(root, 'output/playwright/bracket-ui-assembly.occt.json')
  if (fs.existsSync(uiFile)) {
    const uiDocument = parseDocument(fs.readFileSync(uiFile, 'utf8'))
    const uiGeometry = rebuild(oc, uiDocument)
    assert.deepEqual(uiDocument.assembly.constraints.map(c => c.type), ['FastenedOrigin', 'Cylindrical', 'Planar'])
    assert.ok(uiDocument.assembly.constraints.every(c => !c.draft))
    near(uiGeometry.poses[1000002][0][0], 50); near(uiGeometry.poses[1000002][0][1], 7.5); near(uiGeometry.poses[1000002][0][2], 20)
  }
  assert.throws(() => nativeCommand('v1.assembly.planar', { id: 1, mate1: hole, mate2: pinAxis }, document, undefined, geometry), /平面/)
  assert.throws(() => nativeCommand('v1.assembly.cylindrical', { id: 1, mate1: top, mate2: shoulder }, document, undefined, geometry), /圆柱面/)
  const missing = parseDocument(serializeDocument(document))
  missing.assembly.constraints.find(c => c.id === coaxialId).mate1.geometry.key += '/deleted'
  assert.throws(() => rebuild(oc, missing), /配合面/)
  const conflict = parseDocument(serializeDocument(document))
  conflict.assembly.constraints.push({ ...structuredClone(conflict.assembly.constraints.find(c => c.id === contactId)), id: 2000000 + conflict.assembly.nextConstraint++, values: { zOffset: 5 } })
  assert.throws(() => rebuild(oc, conflict), /冲突/)
  assert.deepEqual(parseDocument(finished).assembly.constraints.find(c => c.id === coaxialId).mate1.geometry, coaxial.mate1.geometry)
  // Publish fixtures only on explicit regeneration; routine tests preserve document UUIDs.
  if (process.env.UPDATE_OCCT_EXAMPLES === '1') {
  fs.writeFileSync(path.join(root, 'examples/locating-pin.occt.json'), serializeDocument(pin) + '\n')
  fs.writeFileSync(path.join(root, 'examples/bracket-assembly-unconstrained.occt.json'), unconstrained + '\n')
  fs.writeFileSync(path.join(root, 'examples/bracket-assembly.occt.json'), finished + '\n')
  }
  console.log('PASS: real hole/cylinder face picks, plane contact, combined joints, native SCG face mapping, STEP face picks, save/reopen, width/diameter/thickness edits, lost references and conflict rejection')
}
