// Runs the same worker kernel source against the real, pinned OCCT WASM in Node.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'buerligons-occt-test-'))
for (const name of [
  'engineeringModel',
  'sketchSolver',
  'partCommands',
  'partValues',
  'sketchRegions',
  'engineeringKernel',
  'engineeringStructure',
  'geometry',
  'analyticSurface',
  'faceReferences',
  'interference',
  'LatestAnalysis',
  'collisionGeometry',
  'rigidMotion',
  'continuousCollision',
  'stepDocument',
  'model',
  'kernel',
  'nativeCommands',
  'adapter',
  'assemblyModel',
  'assemblyCommands',
  'assemblySolver',
]) {
  const source = fs.readFileSync(path.join(root, `src/occt/${name}.ts`), 'utf8')
  fs.writeFileSync(
    path.join(temp, `${name}.js`),
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText,
  )
}
fs.writeFileSync(
  path.join(temp, 'DragSequence.js'),
  ts.transpileModule(fs.readFileSync(path.join(root, 'src/components/canvas/Gizmo/DragSequence.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText,
)
// Adapter dependencies resolve against this checkout, not the temporary test folder.
fs.symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'dir')
const runtimePath = path.join(root, 'node_modules/opencascade.js/dist/opencascade.wasm.js')
const runtime = new Module(runtimePath, module)
runtime.filename = runtimePath
runtime.paths = module.paths
runtime._compile(
  fs.readFileSync(runtimePath, 'utf8').replace('export default opencascade;', 'module.exports = opencascade;'),
  runtimePath,
)
const { rebuild } = require(path.join(temp, 'kernel.js'))
const { nativeCommand } = require(path.join(temp, 'nativeCommands.js'))
const { toStructure } = require(path.join(temp, 'adapter.js'))
const { ScgClassType, ccUtils } = require('@buerli.io/classcad')
const { relativeValues, csysMatrix, matrixCSys } = require(path.join(temp, 'assemblySolver.js'))
const { finite } = require(path.join(temp, 'assemblyModel.js'))
const { Matrix4 } = require('three')
const { emptyDocument, parseDocument, serializeDocument } = require(path.join(temp, 'model.js'))

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < Math.max(1, Math.abs(expected)) * 1e-9, `${actual} != ${expected}`)
}
function triangleVolume(result) {
  let volume = 0
  for (const mesh of result.meshes)
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = mesh.indices.slice(i, i + 3).map(j => mesh.vertices.slice(j * 3, j * 3 + 3))
      volume +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6
    }
  return volume
}

async function main() {
  const oc = await runtime.exports({
    wasmBinary: fs.readFileSync(path.join(root, 'node_modules/opencascade.js/dist/opencascade.wasm.wasm')),
  })
  let document = emptyDocument()
  assert.equal(rebuild(oc, document).edgeCount, 0)
  const assembly = nativeCommand('v1.assembly.create', { name: 'Assembly test' }, document).document
  assert.equal(assembly.kind, 'assembly')
  const assemblyTree = toStructure(assembly)
  assert.equal(assemblyTree.tree[assemblyTree.currentProduct].class, ScgClassType.CCAssemblyRoot)
  assert.equal(ccUtils.base.isA(assemblyTree.tree[assemblyTree.root].class, ScgClassType.CCAssembly), true)
  assert.equal(
    Object.values(assemblyTree.tree).some(o => o.class === ScgClassType.CCPart),
    false,
  )
  assert.deepEqual(parseDocument(serializeDocument(assembly)), assembly)
  assert.equal(rebuild(oc, assembly).edgeCount, 0)
  assert.throws(() => nativeCommand('v1.sketch.create', { id: 1 }, assembly))
  assert.throws(() => parseDocument(JSON.stringify({ ...assembly, rectangle: { x: 0, y: 0, width: 80, height: 50 } })))
  assert.throws(() => parseDocument(JSON.stringify({ ...assembly, kind: 'unknown' })))
  const partAgain = nativeCommand('v1.part.create', { name: 'Part' }, assembly).document
  assert.equal(toStructure(partAgain).tree[1].class, ScgClassType.CCPart)
  const legacy = { ...document }
  delete legacy.kind
  assert.equal(parseDocument(JSON.stringify(legacy)).kind, 'part')
  document.sketch = { planeId: 104 }
  document.rectangle = { x: -20, y: 10, width: 80, height: 50 }
  const sketch = rebuild(oc, document)
  assert.equal(sketch.valid, true)
  assert.equal(sketch.edgeCount, 4)
  assert.equal(sketch.faceCount, 1)
  assert.equal(sketch.meshes.length, 0)
  assert.deepEqual(sketch.min, [-20, 10, 0])
  document.extrusion = { depth: 20 }
  let solid = rebuild(oc, document)
  assert.equal(solid.valid, true)
  assert.equal(solid.faceCount, 6)
  assert.equal(solid.edgeCount, 12)
  near(solid.volume, 80000)
  near(triangleVolume(solid), solid.volume)
  document.rectangle.width = 120
  solid = rebuild(oc, document)
  near(solid.volume, 120000)
  document.extrusion.depth = 35
  solid = rebuild(oc, document)
  near(solid.volume, 210000)
  const reopened = parseDocument(serializeDocument(document))
  assert.deepEqual(reopened, document)
  assert.deepEqual(rebuild(oc, reopened), solid)
  reopened.rectangle.height = 60
  near(rebuild(oc, reopened).volume, 252000)
  for (const invalid of [0, -1, NaN, Infinity, null, '20']) {
    assert.throws(() => rebuild(oc, { ...document, rectangle: { ...document.rectangle, width: invalid } }))
    assert.throws(() => rebuild(oc, { ...document, extrusion: { depth: invalid } }))
  }
  assert.throws(() => parseDocument('{'))
  assert.throws(() => parseDocument(JSON.stringify({ ...document, version: 2 })))
  assert.throws(() => rebuild(oc, { ...document, rectangle: null }))
  // The same command names emitted by the original Sketch/Extrusion editors.
  let native = nativeCommand('v1.part.create', { name: 'Native workflow' }, emptyDocument()).document
  native = nativeCommand('v1.sketch.create', { id: 1 }, native).document
  assert.equal(native.engineering.features[0].planeId, 0)
  assert.throws(() => nativeCommand('v1.sketch.setWorkPlane', { id: 20, planeId: 110 }, native))
  native = nativeCommand('v1.sketch.setWorkPlane', { id: 20, planeId: 104 }, native).document
  native = nativeCommand('v1.sketch.rectangle', { id: 20, startPos: [10, 20, 0], endPos: [90, 70, 0] }, native).document
  native = nativeCommand(
    'v1.sketch.updateDimension',
    { id: native.engineering.features[0].constraints.find(c => c.name === 'Width').dimensionId, value: '120mm' },
    native,
  ).document
  native = nativeCommand('v1.part.createUncommitedObject', { id: 1, type: 'CC_Extrusion' }, native).document
  native = nativeCommand(
    'v1.part.updateExtrusion',
    {
      id: 30,
      references: native.engineering.features[0].regions.map(r => r.id),
      type: 'UP',
      limit2: '35',
      capEnds: true,
    },
    native,
  ).document
  near(rebuild(oc, native).volume, 210000)
  assert.deepEqual(parseDocument(serializeDocument(native)), native)
  assert.throws(() => nativeCommand('v1.part.updateExtrusion', { id: 30, type: 'CUSTOM' }, native))
  assert.throws(() => nativeCommand('v1.part.createUncommitedObject', { type: 'CC_Box' }, native))
  assert.throws(() => nativeCommand('v1.sketch.rectangle', { id: 20, startPos: [0, 0, 0], endPos: [0, 1, 0] }, native))
  // Native product management commands, shared templates, actual OCCT geometry and rigid joints.
  const commit = (d, name, args, view) => {
    const change = nativeCommand(name, args, d, view)
    const next = parseDocument(serializeDocument(change.document || d))
    const geometry = rebuild(oc, next, change.drive)
    if (next.assembly && geometry.poses)
      next.assembly.instances.forEach(i => {
        i.csys = geometry.poses[i.id]
      })
    return { document: next, result: change.result, geometry }
  }
  let asm = nativeCommand('v1.assembly.create', { name: 'Joint tests' }, emptyDocument()).document
  let step = commit(asm, 'v1.assembly.loadProduct', { format: 'OCCT_JSON', data: serializeDocument(document) })
  const encodedImport = commit(asm, 'v1.assembly.loadProduct', {
    format: 'OCCT_JSON',
    encoding: 'base64',
    data: Buffer.from(serializeDocument({ ...document, name: '本地零件' }), 'utf8').toString('base64'),
  })
  assert.equal(encodedImport.document.assembly.parts[0].document.name, '本地零件')
  asm = step.document
  const templateId = step.result.id
  step = commit(asm, 'v1.assembly.instance', { ownerId: 1, productId: templateId })
  asm = step.document
  const first = step.result
  step = commit(asm, 'v1.assembly.instance', {
    ownerId: 1,
    productId: templateId,
    transformation: [
      [200, 80, 40],
      [1, 0, 0],
      [0, 1, 0],
    ],
  })
  asm = step.document
  const second = step.result
  assert.equal(Object.keys(step.geometry.parts).length, 1, 'Instances must reuse a single template BRep')
  near(step.geometry.volume, 420000)
  const tree = toStructure(asm)
  assert.equal(tree.tree[first].link, templateId)
  assert.equal(tree.tree[templateId].class, ScgClassType.CCPart)
  assert.equal(tree.tree[1].solids, undefined, 'An assembly renderer must traverse its instance children')
  assert.deepEqual(tree.tree[901].children, [templateId])
  const mate1 = { path: [first], csys: templateId - 1 + 100 },
    mate2 = { path: [second], csys: templateId - 1 + 100 }
  asm = commit(asm, 'v1.assembly.fastenedOrigin', { id: 1, mate1, xOffset: 10, zRotation: '30deg' }).document
  const poseNear = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} != ${expected}`)
  poseNear(asm.assembly.instances[0].csys[0][0], 10)
  const types = ['Fastened', 'Slider', 'Revolute', 'Cylindrical', 'Planar', 'Parallel', 'Spherical']
  for (const type of types) {
    const method = type[0].toLowerCase() + type.slice(1)
    step = commit(asm, 'v1.assembly.' + method, { id: 1, mate1, mate2 })
    const c = step.document.assembly.constraints.at(-1)
    const relative = relativeValues(step.document, c, step.geometry.poses)
    const locked = {
      Fastened: ['xOffset', 'yOffset', 'zOffset', 'xRotation', 'yRotation', 'zRotation'],
      Slider: ['xOffset', 'yOffset', 'xRotation', 'yRotation', 'zRotation'],
      Revolute: ['xOffset', 'yOffset', 'zOffset', 'xRotation', 'yRotation'],
      Cylindrical: ['xOffset', 'yOffset', 'xRotation', 'yRotation'],
      Planar: ['zOffset', 'xRotation', 'yRotation'],
      Parallel: ['xRotation', 'yRotation'],
      Spherical: ['xOffset', 'yOffset', 'zOffset'],
    }[type]
    locked.forEach(key => poseNear(relative[key], 0))
    const roundtrip = parseDocument(serializeDocument(step.document))
    assert.deepEqual(roundtrip, step.document)
    const again = rebuild(oc, roundtrip)
    Object.keys(again.poses).forEach(id =>
      again.poses[id].flat().forEach((v, i) => poseNear(v, step.geometry.poses[id].flat()[i])),
    )
  }
  step = commit(asm, 'v1.assembly.slider', { id: 1, mate1, mate2, xOffset: 120, zOffsetLimits: { min: 0, max: 100 } })
  let sliderDoc = step.document
  const sliderId = step.result
  step = commit(sliderDoc, 'v1.assembly.update3DConstraintValue', { id: sliderId, name: 'Z_OFFSET', value: 75 })
  sliderDoc = step.document
  const slider = sliderDoc.assembly.constraints.find(c => c.id === sliderId)
  poseNear(relativeValues(sliderDoc, slider, step.geometry.poses).zOffset, 75)
  poseNear(relativeValues(sliderDoc, slider, step.geometry.poses).xOffset, 120)
  assert.throws(() =>
    commit(sliderDoc, 'v1.assembly.update3DConstraintValue', { id: sliderId, name: 'Z_OFFSET', value: 101 }),
  )
  const beforeConflict = serializeDocument(sliderDoc)
  assert.throws(() => commit(sliderDoc, 'v1.assembly.fastenedOrigin', { id: 1, mate1: mate2, xOffset: 999 }))
  assert.equal(serializeDocument(sliderDoc), beforeConflict, 'A failed solve must not mutate the input document')
  // The native gizmo sends a candidate rigid transform. Locked motion is projected out,
  // while the slider's free motion is retained and clamped to its upper limit.
  const dragged = structuredClone(sliderDoc)
  const moved = dragged.assembly.instances.find(i => i.id === second)
  moved.csys = matrixCSys(new Matrix4().makeTranslation(30, 20, 200).multiply(csysMatrix(moved.csys)))
  const projected = rebuild(oc, dragged)
  const projectedValues = relativeValues(dragged, slider, projected.poses)
  poseNear(projectedValues.xOffset, 120)
  poseNear(projectedValues.yOffset, 0)
  poseNear(projectedValues.zOffset, 100)
  assert.throws(() => finite('10mm', true))
  assert.throws(() => finite('10deg', false))
  assert.throws(() =>
    commit(sliderDoc, 'v1.assembly.updateSlider', { id: sliderId, zOffsetLimits: { min: 100, max: 0 } }),
  )
  step = commit(asm, 'v1.assembly.fastened', { id: 1, mate1, mate2, xOffset: 90, zRotation: '90deg' })
  const fastened = step.document.assembly.constraints.at(-1)
  const relation = relativeValues(step.document, fastened, step.geometry.poses)
  poseNear(relation.xOffset, 90)
  poseNear(relation.zRotation, Math.PI / 2)
  // Stable face frames support a bottom-to-top contact independent of triangle numbering.
  step = commit(asm, 'v1.assembly.fastened', {
    id: 1,
    mate1: { ...mate1, csys: templateId - 1 + 111 },
    mate2: { ...mate2, csys: templateId - 1 + 110, flip: '-Z' },
  })
  const faceJoint = step.document.assembly.constraints.at(-1)
  const faceRelation = relativeValues(step.document, faceJoint, step.geometry.poses)
  ;['xOffset', 'yOffset', 'zOffset'].forEach(key => poseNear(faceRelation[key], 0))
  // Editing a template keeps its namespace and updates every instance of it.
  const view = nativeCommand('v1.assembly.setCurrentInstance', { id: first }, asm).view
  assert.equal(view.productId, templateId)
  step = commit(asm, 'v1.sketch.updateDimension', { id: templateId - 1 + 600, value: 150 }, view)
  assert.equal(
    step.document.assembly.parts[0].document.engineering.features[0].constraints.find(c => c.name === 'Width').value,
    150,
  )
  near(step.geometry.volume, 150 * 50 * 35 * 2)
  assert.equal(toStructure(step.document, view).currentProduct, templateId)
  step = commit(asm, 'v1.assembly.deleteInstance', { ids: [first] })
  assert.equal(
    step.document.assembly.constraints.length,
    0,
    'Deleting an instance removes constraints that reference it',
  )
  assert.throws(() => commit(asm, 'v1.assembly.instance', { ownerId: 1, productId: 123456 }))
  assert.throws(() =>
    commit(asm, 'v1.assembly.instance', {
      ownerId: 1,
      productId: templateId,
      transformation: [
        [0, 0, 0],
        [2, 0, 0],
        [0, 1, 0],
      ],
    }),
  )
  assert.throws(() => commit(asm, 'v1.assembly.fastened', { id: 1, mate1, mate2: mate1 }))
  const example = parseDocument(fs.readFileSync(path.join(root, 'examples/assembly.occt.json'), 'utf8'))
  near(rebuild(oc, example).volume, 80 * 50 * 30 * 2)
  console.log(
    'PASS: native import, template edit, repeated insertion, 8 rigid joint kinds, stable face mates, motion values/limits, conflict rejection, persistence and deletion',
  )
  require('./test-bracket.cjs')(oc, {
    nativeCommand,
    rebuild,
    toStructure,
    emptyDocument,
    parseDocument,
    serializeDocument,
    temp,
    root,
  })
  require('./test-bracket-assembly.cjs')(oc, {
    nativeCommand,
    rebuild,
    toStructure,
    emptyDocument,
    parseDocument,
    serializeDocument,
    temp,
    root,
  })
  require('./test-interference.cjs')(oc, { temp, root, emptyDocument, parseDocument, serializeDocument, nativeCommand })
  await require('./test-live-interference.cjs')(oc, { temp, root, parseDocument, nativeCommand, rebuild })
  require('./test-continuous-collision.cjs')(oc, { temp, root, parseDocument, rebuild, emptyDocument })
  await require('./test-live-client.cjs')(oc, { temp, root, parseDocument, rebuild })
  // Repeated rebuilds exercise embind disposal and stale native handles.
  const heapBefore = oc.HEAPU8.length
  for (let i = 0; i < 150; i++) {
    const next = { ...document, extrusion: { depth: 10 + i } }
    near(rebuild(oc, next).volume, document.rectangle.width * document.rectangle.height * next.extrusion.depth)
  }
  assert.equal(oc.HEAPU8.length, heapBefore, 'Repeated small rebuilds unexpectedly grew the WASM heap')
  console.log(
    'PASS: assembly create/type/save/open, legacy Part files, real OCCT rectangle, dimensions, prism, BRep validity, face winding, input rejection, 150 repeated rebuilds',
  )
}
main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }))
