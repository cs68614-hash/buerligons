const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path')
module.exports = (oc, { temp, root, parseDocument, rebuild, emptyDocument }) => {
  const { guardMove, motionClearance } = require(path.join(temp, 'continuousCollision.js'))
  const { checkInterference } = require(path.join(temp, 'interference.js'))
  const cube = (x = 10, y = 10, z = 10) => ({
    ...emptyDocument(),
    rectangle: { x: 0, y: 0, width: x, height: y },
    extrusion: { depth: z },
  })
  const frame = p => [p, [1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const assembly = (part = cube(), obstacle = cube(), position = [-20, 0, 0]) => ({
    ...emptyDocument('assembly'),
    assembly: {
      parts: [
        { id: 10001, document: obstacle },
        { id: 20001, document: part },
      ],
      instances: [
        { id: 1000001, productId: 10001, name: 'Obstacle', csys: frame([0, 0, 0]) },
        { id: 1000002, productId: 20001, name: 'Moving', csys: frame(position) },
      ],
      constraints: [],
      nextPart: 3,
      nextInstance: 3,
      nextConstraint: 1,
    },
  })
  const move = (d, p) => {
    const next = structuredClone(d)
    next.assembly.instances[1].csys = frame(p)
    return next
  }
  const start = assembly(),
    through = move(start, [20, 0, 0])
  assert.equal(checkInterference(oc, through).overlaps.length, 0, 'Target alone is clear; path crosses the obstacle')
  let safe = guardMove(oc, start, through)
  assert.equal(safe.block.reason, 'contact')
  assert.ok(Math.abs(safe.document.assembly.instances[1].csys[0][0] - (-10 - motionClearance)) < motionClearance)
  assert.equal(checkInterference(oc, safe.document, safe.result.poses).overlaps.length, 0)
  assert.equal(safe.block.contacts[0].names[1], 'Moving')
  const again = guardMove(oc, safe.document, through)
  assert.ok(again.block)
  assert.ok(again.document.assembly.instances[1].csys[0][0] <= -10)
  const retreat = guardMove(oc, safe.document, move(start, [-30, 0, 0]))
  assert.equal(retreat.block, undefined)
  assert.deepEqual(retreat.document.assembly.instances[1].csys[0], [-30, 0, 0])
  const group = structuredClone(start)
  group.assembly.instances.push({ id: 1000003, productId: 20001, name: 'Group follower', csys: frame([-40, 0, 0]) })
  group.assembly.nextInstance = 4
  const groupTarget = structuredClone(group)
  groupTarget.assembly.instances.slice(1).forEach(i => {
    i.csys[0][0] += 40
  })
  const groupSafe = guardMove(oc, group, groupTarget)
  assert.ok(groupSafe.block)
  assert.ok(
    Math.abs(
      groupSafe.document.assembly.instances[1].csys[0][0] - groupSafe.document.assembly.instances[2].csys[0][0] - 20,
    ) < 1e-7,
    'A stopped group must preserve relative member poses',
  )
  assert.equal(checkInterference(oc, groupSafe.document, groupSafe.result.poses).overlaps.length, 0)
  const movingTogether = structuredClone(start)
  movingTogether.assembly.instances.forEach(i => {
    i.csys[0][0] += 100
  })
  assert.equal(guardMove(oc, start, movingTogether).block, undefined)
  const badBoolean = Object.create(oc)
  badBoolean.BRepAlgoAPI_Common_3 = class {
    IsDone() {
      return false
    }
    delete() {}
  }
  assert.throws(() => guardMove(badBoolean, start, through), /路径实体求交失败/)
  const heap = oc.HEAPU8.length,
    inputBefore = JSON.stringify(start)
  for (let i = 0; i < 8; i++) assert.ok(guardMove(oc, start, through).block)
  assert.equal(oc.HEAPU8.length, heap, 'Repeated CCD checks should release native handles')
  assert.equal(JSON.stringify(start), inputBefore, 'Path checks cannot mutate input documents')
  const thin = assembly(cube(1, 1, 1), cube(0.01, 10, 10), [-10000, 4, 4])
  safe = guardMove(oc, thin, move(thin, [10000, 4, 4]))
  assert.ok(safe.block, 'Thin obstacle cannot be skipped by a fast pointer event')
  assert.ok(safe.document.assembly.instances[1].csys[0][0] <= -1)
  assert.equal(checkInterference(oc, safe.document, safe.result.poses).overlaps.length, 0)
  const tangent = assembly(cube(), cube(), [-20, 10, 0])
  assert.equal(guardMove(oc, tangent, move(tangent, [20, 10, 0])).block, undefined, 'Sliding along a face is allowed')
  const overlap = assembly(cube(), cube(), [5, 0, 0])
  safe = guardMove(oc, overlap, move(overlap, [20, 0, 0]))
  assert.equal(safe.block.reason, 'initialOverlap')
  assert.equal(safe.block.fraction, 0)
  const contained = assembly(cube(1, 1, 1), cube(), [4, 4, 4])
  safe = guardMove(oc, contained, move(contained, [20, 4, 4]))
  assert.equal(safe.block.reason, 'initialOverlap', 'Contained solids also require a valid initial pose')
  // A long bar rotates around its origin through an obstacle, with clear start/end poses.
  const rotate = assembly(cube(20, 1, 1), cube(2, 2, 2), [0, 0, 0])
  rotate.assembly.instances[0].csys[0] = [8, 8, 0]
  const rotated = structuredClone(rotate)
  rotated.assembly.instances[1].csys = [
    [0, 0, 0],
    [0, 1, 0],
    [-1, 0, 0],
    [0, 0, 1],
  ]
  assert.equal(checkInterference(oc, rotate).overlaps.length, 0)
  assert.equal(checkInterference(oc, rotated).overlaps.length, 0)
  safe = guardMove(oc, rotate, rotated)
  assert.ok(safe.block, 'Rotation arc must collide even with clear endpoints')
  assert.ok(safe.block.fraction > 0 && safe.block.fraction < 1)
  assert.equal(checkInterference(oc, safe.document, safe.result.poses).overlaps.length, 0)
  // Bracket head at contact cannot be pushed into the shoulder, but axial withdrawal should remain usable.
  const bracket = parseDocument(fs.readFileSync(path.join(root, 'examples/bracket-assembly.occt.json'), 'utf8'))
  bracket.assembly.constraints = bracket.assembly.constraints.filter(c => c.type !== 'Planar')
  const withdraw = structuredClone(bracket)
  withdraw.assembly.instances[1].csys[0][2] += 10
  safe = guardMove(oc, bracket, withdraw)
  assert.equal(safe.block, undefined, 'Snug hole-wall contact must allow axial withdrawal')
  const penetrate = structuredClone(bracket)
  penetrate.assembly.instances[1].csys[0][2] -= 10
  safe = guardMove(oc, bracket, penetrate)
  assert.ok(safe.block)
  assert.ok(Math.abs(safe.document.assembly.instances[1].csys[0][2] - 20) < 0.001)
  assert.equal(checkInterference(oc, safe.document, safe.result.poses).overlaps.length, 0)
  console.log(
    'PASS: swept translation no tunnelling, thin barriers, repeat blocking/retreat, tangent sliding, initial overlap, rotating bar arc, snug bracket withdrawal/head stop',
  )
}
