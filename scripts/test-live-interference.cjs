const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
module.exports = async (oc, { temp, root, parseDocument, nativeCommand, rebuild }) => {
  const { LatestAnalysis } = require(path.join(temp, 'LatestAnalysis.js'))
  const { DragSequence } = require(path.join(temp, 'DragSequence.js'))
  const calls = [], ready = [], errors = [], tasks = []
  let pending = 0
  const scheduler = new LatestAnalysis(input => {
    calls.push(input)
    const task = deferred(); tasks.push(task); return task.promise
  }, () => pending++, result => ready.push(result), error => errors.push(error.message), 0)
  scheduler.schedule('old')
  const final = scheduler.flush()
  scheduler.schedule('discarded')
  scheduler.schedule('release')
  assert.deepEqual(calls, ['old'], 'Only one analysis may be in flight')
  tasks[0].resolve('stale collision')
  await tick(); await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(ready, [], 'Stale collision must not be rendered at the new pose')
  assert.deepEqual(calls, ['old', 'release'], 'Intermediate poses must coalesce')
  tasks[1].resolve('final clear')
  assert.equal(await final, 'final clear')
  assert.deepEqual(ready, ['final clear']); assert.equal(pending, 3)
  assert.equal(await scheduler.flush(), 'final clear', 'Release must reuse an already completed final check')
  scheduler.schedule('disabled')
  const canceled = scheduler.flush().catch(e => e.message)
  scheduler.cancel(); tasks[2].resolve('disabled collision')
  await tick()
  assert.equal(await canceled, '干涉检查已取消。'); assert.equal(ready.length, 1)
  scheduler.schedule('failure')
  const failed = scheduler.flush().catch(e => e.message)
  tasks[3].reject(new Error('bad BRep'))
  assert.equal(await failed, 'bad BRep'); assert.deepEqual(errors, ['bad BRep'])
  scheduler.schedule('recover'); const recovered = scheduler.flush(); tasks[4].resolve('recovered')
  assert.equal(await recovered, 'recovered')
  // Closing a document while checking cannot publish the completed result or its error.
  scheduler.schedule('closed'); const closed = scheduler.flush().catch(e => e.message)
  scheduler.cancel(); tasks[5].reject(new Error('closed worker')); await closed; await tick()
  assert.deepEqual(errors, ['bad BRep']); assert.deepEqual(ready, ['final clear', 'recovered'])

  const started = deferred(), first = deferred(), last = deferred(), order = []
  const drag = new DragSequence(started.promise, value => {
    order.push(`move ${value}`); return value === 1 ? first.promise : last.promise
  }, async () => { order.push('end') })
  drag.update(1); assert.deepEqual(order, [])
  started.resolve(); await tick(); assert.deepEqual(order, ['move 1'])
  drag.update(2); drag.update(3)
  const ended = drag.finish(); drag.update(4)
  assert.deepEqual(order, ['move 1'], 'Finish must wait for outstanding native moves')
  first.resolve(); await tick(); assert.deepEqual(order, ['move 1', 'move 3'])
  last.resolve(); await ended
  assert.deepEqual(order, ['move 1', 'move 3', 'end'], 'Release position must be sent before finish')
  await drag.finish(); assert.equal(order.filter(v => v === 'end').length, 1)
  const shortStart = deferred(), shortOrder = []
  const short = new DragSequence(shortStart.promise, async value => { shortOrder.push(value) }, async () => { shortOrder.push('end') })
  short.update(7); const shortEnd = short.finish(); shortStart.resolve(); await shortEnd
  assert.deepEqual(shortOrder, [7, 'end'], 'A quick release before start completes must still move')

  const { checkInterference } = require(path.join(temp, 'interference.js'))
  const fixture = parseDocument(fs.readFileSync(path.join(root, 'examples/assembly.occt.json'), 'utf8'))
  fixture.name = 'Realtime slider collision demo'
  fixture.assembly.parts[0].document.rectangle = { x: 0, y: 0, width: 10, height: 10 }
  fixture.assembly.parts[0].document.extrusion = { depth: 10 }
  fixture.assembly.instances[0].name = 'Fixed block'
  fixture.assembly.instances[1].name = 'Sliding block'
  fixture.assembly.instances[1].csys[0] = [0, 0, 15]
  fixture.assembly.constraints[1].values.xOffset = 0
  fixture.assembly.constraints[1].limits.zOffsetLimits.max = 20
  const original = JSON.stringify(fixture)
  for (const [value, volume] of [[15, 0], [5, 500], [0, 1000], [10, 0], [20, 0]]) {
    const edit = nativeCommand('v1.assembly.update3DConstraintValue', { id: 2000002, name: 'Z_OFFSET', value }, fixture)
    const result = rebuild(oc, edit.document, edit.drive)
    const report = checkInterference(oc, edit.document, result.poses)
    assert.equal(report.errors.length, 0)
    assert.equal(report.overlaps.length, volume ? 1 : 0)
    if (volume) assert.ok(Math.abs(report.overlaps[0].volume - volume) < 1e-6)
    assert.ok(Math.abs(result.poses[1000002][0][2] - value) < 1e-4, JSON.stringify({ value, pose: result.poses[1000002] }))
  }
  assert.equal(JSON.stringify(fixture), original, 'Live analysis must not alter the stored constraint or pose')
  const preview = structuredClone(fixture)
  preview.assembly.constraints.push({ ...preview.assembly.constraints[1], id: 2000003, draft: true, mate1: null, mate2: null })
  preview.assembly.nextConstraint++
  const poses = rebuild(oc, fixture, { constraintId: 2000002, name: 'zOffset', value: 5 }).poses
  assert.ok(Math.abs(checkInterference(oc, preview, poses).overlaps[0].volume - 500) < 1e-6,
    'Draft editor analysis must match the displayed solved pose')
  assert.throws(() => checkInterference(oc, preview), /应用|关闭/)
  assert.throws(() => checkInterference(oc, fixture, { ...poses, 1000002: undefined }), /变换/)
  // A rejected constraint edit never supplies a new pose for the analyser.
  assert.throws(() => {
    const invalid = nativeCommand('v1.assembly.update3DConstraintValue', { id: 2000002, name: 'Z_OFFSET', value: 21 }, fixture)
    rebuild(oc, invalid.document, invalid.drive)
  }, /范围|限位|限制|limits/)
  const onDisk = fs.readFileSync(path.join(root, 'examples/assembly-live-interference.occt.json'), 'utf8')
  assert.deepEqual(parseDocument(onDisk), parseDocument(JSON.stringify(fixture)))
  console.log('PASS: realtime latest-only worker scheduling, stale success/error suppression, disable/close/recovery, final drag flush, native slider collision/clear/contact, displayed preview poses')
}
