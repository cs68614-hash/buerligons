const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

module.exports = async (oc, { temp, root, parseDocument, rebuild }) => {
  const { checkInterference } = require(path.join(temp, 'interference.js'))
  fs.writeFileSync(
    path.join(temp, 'OcctClient.js'),
    ts.transpileModule(fs.readFileSync(path.join(root, 'src/occt/OcctClient.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText,
  )
  const drawing = {
    api: {
      cad: { setConnected() {}, setActive() {}, setStates() {} },
      structure: { set() {} },
      graphic: { addPackages() {} },
    },
  }
  const checked = []
  const { guardMove } = require(path.join(temp, 'continuousCollision.js'))
  let rejectGuard = false
  const kernelService = {
    rebuild: async (doc, drive) => rebuild(oc, doc, drive),
    guardMove: async (start, target) => {
      if (rejectGuard) throw new Error('Injected path failure')
      return guardMove(oc, start, target)
    },
  }
  const interferenceService = {
    async checkInterference(doc, poses) {
      checked.push({ doc, poses })
      return checkInterference(oc, doc, poses)
    },
    dispose() {},
  }
  const originalLoad = Module._load
  let clientModule
  try {
    Module._load = function (request, parent, ...rest) {
      if (parent?.filename === fs.realpathSync(path.join(temp, 'OcctClient.js'))) {
        if (request === './KernelService') return { kernelService, interferenceService }
        if (request === '@buerli.io/core') return { getDrawing: () => drawing }
        if (request === '@buerli.io/classcad')
          return {
            AwvNodeClient: class {
              setDrawingId(id) {
                this.drawingId = id
              }
              emit() {}
            },
          }
      }
      return originalLoad.call(this, request, parent, ...rest)
    }
    clientModule = require(path.join(temp, 'OcctClient.js'))
  } finally {
    Module._load = originalLoad
  }
  const { OcctClient, useOcct } = clientModule
  useOcct.setState({ liveInterference: true })
  const client = new OcctClient('live-test')
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000
    while (!predicate(useOcct.getState())) {
      if (Date.now() > deadline) throw new Error(`Client inspection timed out: ${useOcct.getState().interferenceError}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const execute = async (name, args) => {
    const response = await client.requestByName('Execute', { command: 'Execute', task: [{ [name]: [args] }] })
    assert.equal(response.maxLevel, 0, JSON.stringify(response.messages))
    return response.result
  }
  const fixture = parseDocument(
    fs.readFileSync(path.join(root, 'examples/assembly-live-interference.occt.json'), 'utf8'),
  )
  await client.connect()
  await client.replace(fixture)
  assert.equal(
    useOcct.getState().checkingInterference,
    true,
    'Opening an assembly should schedule inspection by default',
  )
  await waitFor(s => !!s.interference)
  assert.equal(useOcct.getState().interference.overlaps.length, 0)
  const initial = JSON.stringify(client.document)
  // Native start/move/end messages are the same ones used by the existing PivotControls.
  await execute('v1.assembly.startMovingUnderConstraints', { id: 1, instanceIds: [1000002] })
  await execute('v1.assembly.moveUnderConstraints', { id: 1, offset: [0, 0, -8] })
  await execute('v1.assembly.moveUnderConstraints', { id: 1, offset: [0, 0, -10] })
  await execute('v1.assembly.finishMovingUnderConstraints', { id: 1 })
  await waitFor(s => !!s.interference)
  assert.equal(useOcct.getState().interference.overlaps.length, 0)
  assert.equal(useOcct.getState().motionBlock.reason, 'contact')
  assert.ok(client.document.assembly.instances[1].csys[0][2] >= 10)
  assert.ok(client.document.assembly.instances[1].csys[0][2] < 10.001)
  const revision = useOcct.getState().revision
  await client.checkInterference()
  assert.equal(useOcct.getState().revision, revision, 'Analysis is not a CAD history step')
  await client.undo()
  await waitFor(s => !!s.interference)
  assert.equal(useOcct.getState().interference.overlaps.length, 0)
  assert.equal(JSON.stringify(client.document), initial, 'The entire drag must undo in one step')
  await client.redo()
  await waitFor(s => !!s.interference)
  assert.equal(useOcct.getState().interference.overlaps.length, 0)
  assert.ok(client.document.assembly.instances[1].csys[0][2] >= 10)
  await execute('v1.assembly.update3DConstraintValue', { id: 2000002, name: 'Z_OFFSET', value: 15 })
  await waitFor(s => !!s.interference && !s.interference.overlaps.length)
  assert.equal(useOcct.getState().busy, false)
  // Failed native solver values leave the last displayed pose and valid analysis intact.
  const beforeRejected = JSON.stringify(client.document)
  const invalid = await client.requestByName('Execute', {
    command: 'Execute',
    task: [
      {
        'v1.assembly.update3DConstraintValue': [{ id: 2000002, name: 'Z_OFFSET', value: 21 }],
      },
    ],
  })
  assert.equal(invalid.maxLevel, 51)
  assert.equal(JSON.stringify(client.document), beforeRejected)
  assert.equal(useOcct.getState().interference.overlaps.length, 0)
  client.setLiveInterference(false)
  await execute('v1.assembly.startMovingUnderConstraints', { id: 1, instanceIds: [1000002] })
  const beforeGuardFailure = JSON.stringify(client.document)
  rejectGuard = true
  const failedMove = await client.requestByName('Execute', {
    command: 'Execute',
    task: [
      {
        'v1.assembly.moveUnderConstraints': [{ id: 1, offset: [0, 0, -20] }],
      },
    ],
  })
  assert.equal(failedMove.maxLevel, 51)
  assert.equal(JSON.stringify(client.document), beforeGuardFailure)
  assert.equal(useOcct.getState().guardingMove, false)
  assert.match(useOcct.getState().motionError, /Injected/)
  rejectGuard = false
  await execute('v1.assembly.moveUnderConstraints', { id: 1, offset: [0, 0, -20] })
  assert.equal(
    useOcct.getState().motionBlock.reason,
    'contact',
    'Live inspection switch must not disable penetration prevention',
  )
  assert.ok(client.document.assembly.instances[1].csys[0][2] >= 10)
  const stoppedSave = await client.getDocumentForSave()
  assert.deepEqual(stoppedSave.assembly.instances, client.document.assembly.instances)
  await execute('v1.assembly.moveUnderConstraints', { id: 1, offset: [0, 0, 3] })
  assert.equal(useOcct.getState().motionBlock, undefined, 'Retreat must clear the stop marker')
  assert.ok(Math.abs(client.document.assembly.instances[1].csys[0][2] - 18) < 1e-7)
  await execute('v1.assembly.finishMovingUnderConstraints', { id: 1 })
  const count = checked.length
  await execute('v1.assembly.update3DConstraintValue', { id: 2000002, name: 'Z_OFFSET', value: 5 })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(checked.length, count)
  client.setLiveInterference(true)
  await waitFor(s => !!s.interference?.overlaps.length)
  const bracket = parseDocument(fs.readFileSync(path.join(root, 'examples/bracket-assembly.occt.json'), 'utf8'))
  await client.replace(bracket)
  await waitFor(s => !!s.interference)
  assert.equal(useOcct.getState().interference.overlaps.length, 0)
  await execute('v1.assembly.updatePlanar', { id: 2000003, zOffset: -2 })
  await waitFor(s => !!s.interference?.overlaps.length)
  assert.ok(
    Math.abs(useOcct.getState().interference.overlaps[0].volume - 2 * Math.PI * (36 - 9)) < 0.001,
    'Bracket contact offset must show the actual pin-head annulus penetrating the bracket',
  )
  await execute('v1.assembly.updatePlanar', { id: 2000003, zOffset: 0 })
  await waitFor(s => !!s.interference && !s.interference.overlaps.length)
  // Axial motion is allowed after removing the planar lock, keeping the cylindrical hole/shaft mate.
  bracket.assembly.constraints = bracket.assembly.constraints.filter(c => c.type !== 'Planar')
  await client.replace(bracket)
  await execute('v1.assembly.update3DConstraintValue', { id: 2000002, name: 'Z_OFFSET', value: -2 })
  await waitFor(s => !!s.interference?.overlaps.length)
  assert.ok(Math.abs(useOcct.getState().interference.overlaps[0].volume - 2 * Math.PI * (36 - 9)) < 0.001)
  await execute('v1.assembly.update3DConstraintValue', { id: 2000002, name: 'Z_OFFSET', value: 0 })
  await waitFor(s => !!s.interference && !s.interference.overlaps.length)
  const saved = await client.getDocumentForSave()
  assert.equal('interference' in saved, false, 'Inspection must not be persisted')
  await client.disconnect()
  assert.equal(useOcct.getState().interference, undefined)
  assert.equal(useOcct.getState().checkingInterference, false)
  console.log(
    'PASS: native local client live checks after drag/constraint/undo/redo, guarded drag/history/save/retreat, path failure preservation, disable/enable, failed edit preservation, save/disconnect',
  )
}
