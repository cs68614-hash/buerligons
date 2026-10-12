const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

module.exports = function testInterference(oc, { temp, root, emptyDocument, parseDocument, serializeDocument, nativeCommand }) {
  const { checkInterference } = require(path.join(temp, 'interference.js'))
  const { matrixCSys } = require(path.join(temp, 'assemblySolver.js'))
  const { Matrix4 } = require('three')
  const near = (actual, expected, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`)
  const cube = (width = 10, height = 10, depth = 10) => ({ ...emptyDocument(), name: 'Box', rectangle: { x: 0, y: 0, width, height }, extrusion: { depth } })
  const assembly = (first, second, transform = new Matrix4()) => ({
    ...emptyDocument('assembly'), name: 'Interference test', assembly: {
      parts: [{ id: 10001, document: first }, ...(second === first ? [] : [{ id: 20001, document: second }])],
      instances: [
        { id: 1000001, productId: 10001, name: 'First', csys: matrixCSys(new Matrix4()) },
        { id: 1000002, productId: second === first ? 10001 : 20001, name: 'Second', csys: matrixCSys(transform) },
      ], constraints: [], nextPart: 3, nextInstance: 3, nextConstraint: 1,
    },
  })
  const box = cube()
  const overlap = assembly(box, box, new Matrix4().makeTranslation(5, 0, 0))
  const original = serializeDocument(overlap)
  let report = checkInterference(oc, overlap)
  assert.equal(report.errors.length, 0)
  assert.equal(report.totalPairs, 1); assert.equal(report.checkedPairs, 1)
  assert.equal(report.overlaps.length, 1)
  assert.deepEqual(report.overlaps[0].instanceIds, [1000001, 1000002])
  near(report.overlaps[0].volume, 500)
  assert.deepEqual(report.overlaps[0].geometry.min, [5, 0, 0])
  assert.deepEqual(report.overlaps[0].geometry.max, [10, 10, 10])
  assert.equal(serializeDocument(overlap), original, 'Inspection must not mutate instances, constraints or revision data')
  for (const p of [[10,0,0], [10,10,0], [10,10,10], [25,0,0]]) {
    report = checkInterference(oc, assembly(box, box, new Matrix4().makeTranslation(...p)))
    assert.equal(report.overlaps.length, 0, 'Face, edge and vertex contact are not material overlap')
    assert.equal(report.checkedPairs, 1)
  }
  report = checkInterference(oc, assembly(box, cube(2,2,2), new Matrix4().makeTranslation(4,4,4)))
  near(report.overlaps[0].volume, 8, 1e-8)
  report = checkInterference(oc, assembly(box, box))
  near(report.overlaps[0].volume, 1000)
  // World-space rotated BReps, not an intersection of transformed display boxes.
  const rotation = new Matrix4().makeRotationZ(Math.PI / 2).setPosition(15, 0, 0)
  report = checkInterference(oc, assembly(cube(10,20,10), cube(10,20,10), rotation))
  near(report.overlaps[0].volume, 1000)
  assert.deepEqual(report.overlaps[0].geometry.min.map(v => Math.round(v)), [0,0,0])
  const moved = structuredClone(overlap)
  moved.assembly.instances.forEach(i => { i.csys[0][0] += 100; i.csys[0][1] -= 30; i.csys[0][2] += 50 })
  report = checkInterference(oc, moved)
  near(report.overlaps[0].volume, 500)
  assert.deepEqual(report.overlaps[0].geometry.min, [105,-30,50])
  // Same template instances still get individually placed BReps.
  const third = structuredClone(overlap)
  third.assembly.instances.push({ id: 1000003, productId: 10001, name: 'Third', csys: matrixCSys(new Matrix4().makeTranslation(8,0,0)) })
  third.assembly.nextInstance = 4
  report = checkInterference(oc, third)
  assert.equal(report.totalPairs, 3); assert.equal(report.checkedPairs, 3)
  assert.deepEqual(report.overlaps.map(r => Math.round(r.volume)), [500,200,700])
  // Separate body features in a template must count their union, without double-counting material.
  let multi = emptyDocument()
  multi = nativeCommand('v1.sketch.create', { id: 1 }, multi).document
  multi = nativeCommand('v1.sketch.setWorkPlane', { id: 20, planeId: 104 }, multi).document
  multi = nativeCommand('v1.sketch.rectangle', { id: 20, startPos: [0,0,0], endPos: [10,10,0] }, multi).document
  const regions = multi.engineering.features[0].regions.map(r => r.id)
  for (let i = 0; i < 2; i++) multi = nativeCommand('v1.part.extrusion', { id: 1, references: regions, limit2: 10 }, multi).document
  report = checkInterference(oc, assembly(multi, box, new Matrix4().makeTranslation(5,0,0)))
  assert.equal(report.overlaps.length, 1); near(report.overlaps[0].volume, 500)

  const bracket = parseDocument(fs.readFileSync(path.join(root, 'examples/bracket-assembly.occt.json'), 'utf8'))
  report = checkInterference(oc, bracket)
  assert.equal(report.errors.length, 0)
  assert.equal(report.overlaps.length, 0, 'The correctly mated pin and shoulder must not report collision')
  const oversized = structuredClone(bracket)
  const pin = oversized.assembly.parts[1].document
  oversized.assembly.parts[1].document = nativeCommand('v1.sketch.updateDimension', { id: 703, value: 8 }, pin).document
  report = checkInterference(oc, oversized)
  assert.equal(report.errors.length, 0); assert.equal(report.overlaps.length, 1)
  near(report.overlaps[0].volume, Math.PI * (4 * 4 - 3 * 3) * 20, 1e-3)
  assert.ok(report.overlaps[0].geometry.meshes.length > 0)
  const offset = structuredClone(bracket)
  offset.assembly.constraints = []
  offset.assembly.instances[1].csys = matrixCSys(new Matrix4().makeTranslation(52,7.5,20))
  report = checkInterference(oc, offset)
  assert.equal(report.overlaps.length, 1)
  assert.ok(report.overlaps[0].volume > 200)
  const { importStepDocument } = require(path.join(temp, 'stepDocument.js'))
  const stepBracket = importStepDocument('STEP bracket', fs.readFileSync(path.join(root, 'examples/bracket.step'), 'utf8'))
  report = checkInterference(oc, assembly(stepBracket, pin, new Matrix4().makeTranslation(50,7.5,20)))
  assert.equal(report.overlaps.length, 0, 'STEP holes must use the BRep, not the envelope')
  report = checkInterference(oc, assembly(stepBracket, pin, new Matrix4().makeTranslation(52,7.5,20)))
  assert.equal(report.overlaps.length, 1)

  report = checkInterference(oc, assembly(box, emptyDocument()))
  assert.equal(report.ignoredInstances.length, 1); assert.equal(report.checkedPairs, 0)
  assert.equal(report.overlaps.length, 0)
  assert.throws(() => checkInterference(oc, box), /装配/)
  const draft = structuredClone(bracket)
  draft.assembly.constraints[0].draft = true
  assert.throws(() => checkInterference(oc, draft), /应用或关闭/)
  const failed = structuredClone(overlap)
  failed.assembly.instances[1].csys[1][0] = 2
  assert.throws(() => checkInterference(oc, failed), /刚体/)
  // Failed boolean pairs must remain errors, never a green all-clear result.
  const failCommon = new Proxy(oc, { get(target, key) {
    if (key === 'BRepAlgoAPI_Common_3') return class { IsDone() { return false } delete() {} }
    return target[key]
  } })
  report = checkInterference(failCommon, overlap)
  assert.equal(report.errors.length, 1); assert.equal(report.checkedPairs, 0)
  assert.equal(report.overlaps.length, 0)
  const fixture = parseDocument(fs.readFileSync(path.join(root, 'examples/bracket-assembly-interference.occt.json'), 'utf8'))
  near(checkInterference(oc, fixture).overlaps[0].volume, Math.PI * 7 * 20, 1e-3)
  const heap = oc.HEAPU8.length
  for (let i = 0; i < 40; i++) near(checkInterference(oc, overlap).overlaps[0].volume, 500)
  assert.equal(oc.HEAPU8.length, heap, 'Repeated interference checks unexpectedly grew the WASM heap')

  const example = structuredClone(oversized)
  example.name = 'Bracket interference example'
  if (process.env.UPDATE_OCCT_EXAMPLES === '1') fs.writeFileSync(path.join(root, 'examples/bracket-assembly-interference.occt.json'), serializeDocument(example) + '\n')
  console.log('PASS: exact BRep interference, contact/containment, shared templates, rotations/world coordinates, three pairs, multi-body union, bracket hole/oversized pin, STEP, no mutation, empty/draft/error handling and 40 repeated checks')
}
