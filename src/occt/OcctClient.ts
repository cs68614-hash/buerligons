import { AwvNodeClient, ServerRequest, ServerResponse, UndoOptions, RedoOptions } from '@buerli.io/classcad'
import { DrawingID, getDrawing } from '@buerli.io/core'
import create from 'zustand'
import {
  CadDocument,
  emptyDocument,
  KernelResult,
  InterferenceReport,
  ModelView,
  MotionBlock,
  rootView,
  validateDocument,
} from './model'
import { csysMatrix, matrixCSys } from './assemblySolver'
import { Matrix4, Vector3 } from 'three'
import { kernelService, interferenceService } from './KernelService'
import { LatestAnalysis } from './LatestAnalysis'
import { toGraphic, toStructure } from './adapter'
import { nativeCommand } from './nativeCommands'

type PilotState = {
  client?: OcctClient
  document: CadDocument
  result?: KernelResult
  interference?: InterferenceReport
  interferenceSelection?: string
  interferenceFocus: number
  liveInterference: boolean
  interferenceError: string
  checkingInterference: boolean
  guardingMove: boolean
  motionBlock?: MotionBlock
  motionError: string
  busy: boolean
  error: string
  revision: number
  canUndo: boolean
  canRedo: boolean
}
export const useOcct = create<PilotState>(() => ({
  document: emptyDocument(),
  interferenceFocus: 0,
  liveInterference: true,
  interferenceError: '',
  checkingInterference: false,
  busy: false,
  guardingMove: false,
  motionError: '',
  error: '',
  revision: 0,
  canUndo: false,
  canRedo: false,
}))

/** A local engine adapter; no ClassCAD transport, token or proprietary WASM is constructed. */
export class OcctClient extends AwvNodeClient {
  private history: CadDocument[] = [emptyDocument()]
  private position = 0
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private draftPosition?: number
  private view: ModelView = rootView()
  private moving?: { ids: number[]; document: CadDocument; position: number }
  private latestResult?: KernelResult
  private analysis = new LatestAnalysis<{ document: CadDocument; result: KernelResult }, InterferenceReport>(
    snapshot => interferenceService.checkInterference(snapshot.document, snapshot.result.poses),
    () => this.analysisState({ checkingInterference: true, interference: undefined, interferenceError: '' }),
    interference => this.analysisState({ interference, checkingInterference: false, interferenceError: '' }),
    error =>
      this.analysisState({ interference: undefined, checkingInterference: false, interferenceError: error.message }),
  )

  private analysisState(state: Partial<PilotState>): void {
    if (!this.closed && useOcct.getState().client === this) useOcct.setState(state)
  }
  setLiveInterference(enabled: boolean): void {
    this.analysis.cancel()
    this.analysisState({
      liveInterference: enabled,
      checkingInterference: false,
      interference: undefined,
      interferenceSelection: undefined,
      interferenceError: '',
    })
    if (enabled) this.scheduleInterference()
  }
  private scheduleInterference(): void {
    if (this.document.assembly && this.view.productId === 1 && this.latestResult)
      this.analysis.schedule({ document: this.document, result: this.latestResult })
    else this.analysis.cancel()
  }

  constructor(drawingId: DrawingID) {
    super()
    this.setDrawingId(drawingId)
  }
  async connect(): Promise<this> {
    useOcct.setState({
      client: this,
      guardingMove: false,
      motionBlock: undefined,
      motionError: '',
      busy: true,
      error: '',
      interferenceError: '',
      interference: undefined,
      interferenceSelection: undefined,
      checkingInterference: false,
    })
    try {
      const result = await kernelService.rebuild(this.document)
      // The native create command (or file open) determines the document type.
      // Connecting alone must not publish a phantom Part before assembly.create.
      useOcct.setState({ result, busy: false })
      getDrawing(this.drawingId).api.cad.setConnected(true)
      getDrawing(this.drawingId).api.cad.setActive(true)
      this.emit('connected', this)
      return this
    } catch (error) {
      useOcct.setState({ busy: false, error: String(error) })
      throw error
    }
  }
  async disconnect(): Promise<this> {
    this.closed = true
    this.analysis.cancel()
    if (useOcct.getState().client === this) {
      interferenceService.dispose()
      useOcct.setState({
        interference: undefined,
        interferenceSelection: undefined,
        checkingInterference: false,
        guardingMove: false,
        motionBlock: undefined,
        motionError: '',
      })
    }
    getDrawing(this.drawingId)?.api.cad.setConnected(false)
    return this
  }
  get document(): CadDocument {
    return structuredClone(this.history[this.position])
  }
  async getDocumentForSave(): Promise<CadDocument> {
    await this.queue
    // An unapplied native editor preview must not become a persisted feature or joint.
    return structuredClone(this.history[this.draftPosition ?? this.position])
  }
  checkInterference(): Promise<InterferenceReport> {
    return this.enqueue(async () => {
      this.scheduleInterference()
      return this.analysis.flush()
    })
  }
  private solved(document: CadDocument, result: KernelResult): CadDocument {
    if (document.assembly)
      for (const constraint of document.assembly.constraints)
        for (const mate of [constraint.mate1, constraint.mate2]) {
          const instance = document.assembly.instances.find(i => i.id === mate?.path[0])
          if (mate?.geometry && instance) {
            const entry = Object.entries(result.parts?.[instance.productId]?.mateFrames || {}).find(
              ([, face]) => face.key === mate.geometry!.key,
            )
            if (!entry) throw new Error('配合面已经不存在或发生歧义，修改未提交。')
            mate.csys = instance.productId - 1 + Number(entry[0])
          }
        }
    if (document.assembly && result.poses)
      document.assembly.instances.forEach(instance => {
        instance.csys = result.poses![instance.id]
      })
    return document
  }
  private recordRevision(next: CadDocument): void {
    const previous = this.document
    const bump = (d: CadDocument, old?: CadDocument) => {
      if (d.engineering && JSON.stringify(d.engineering.features) !== JSON.stringify(old?.engineering?.features))
        d.engineering.modelRevision = (old?.engineering?.modelRevision ?? 0) + 1
    }
    bump(next, previous)
    for (const part of next.assembly?.parts || [])
      bump(part.document, previous.assembly?.parts.find(p => p.id === part.id)?.document)
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.run(action))
    this.queue = next.catch(() => undefined)
    return next
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('模型已经关闭。')
    useOcct.setState({ busy: true, error: '' })
    try {
      return await action()
    } catch (error) {
      useOcct.setState({ error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      useOcct.setState({ busy: false })
    }
  }

  change(next: CadDocument): Promise<void> {
    return this.enqueue(async () => {
      const document = validateDocument(next)
      const result = await kernelService.rebuild(document)
      this.recordRevision(document)
      // Commit parameters/history only after OCCT has built and validated the new BRep.
      this.history = [...this.history.slice(0, this.position + 1), this.solved(document, result)]
      this.position++
      this.publish(result)
      return undefined
    })
  }
  replace(next: CadDocument): Promise<void> {
    return this.enqueue(async () => {
      const document = validateDocument(next)
      const result = await kernelService.rebuild(document)
      this.history = [this.solved(document, result)]
      this.position = 0
      this.draftPosition = undefined
      this.view = rootView()
      this.moving = undefined
      this.publish(result)
      return undefined
    })
  }

  private publish(result: KernelResult, fromMove = false) {
    if (!fromMove) this.moving = undefined
    if (this.closed) throw new Error('模型已经关闭。')
    const document = this.document
    const drawing = getDrawing(this.drawingId)
    this.latestResult = result
    if (this.view.productId !== 1 && !document.assembly?.parts.some(p => p.id === this.view.productId))
      this.view = rootView()
    if (this.view.instanceId >= 1000000 && !document.assembly?.instances.some(i => i.id === this.view.instanceId))
      this.view = rootView()
    drawing.api.structure.set(toStructure(document, this.view, result))
    drawing.api.graphic.addPackages([toGraphic(document, result)])
    drawing.api.cad.setStates(
      this.position,
      this.history.map((_, i) => String(i)),
      Object.fromEntries(
        this.history.map((d, i) => [
          String(i),
          {
            stateName: String(i),
            caption: d.kind === 'assembly' ? 'Assembly' : d.extrusion ? 'Extrusion' : 'Part',
            undoable: true,
          },
        ]),
      ),
    )
    useOcct.setState(s => ({
      document,
      result,
      interference: undefined,
      interferenceSelection: undefined,
      interferenceError: '',
      checkingInterference: false,
      motionBlock: undefined,
      motionError: '',
      revision: s.revision + 1,
      busy: false,
      canUndo: this.position > 0,
      canRedo: this.position < this.history.length - 1,
    }))
    if (useOcct.getState().liveInterference) this.scheduleInterference()
    else this.analysis.cancel()
  }
  undo(options?: UndoOptions): Promise<ServerResponse> {
    return this.restore(options?.state ? Number(options.state) : this.position - 1)
  }
  redo(options?: RedoOptions): Promise<ServerResponse> {
    return this.restore(options?.state ? Number(options.state) : this.position + 1)
  }
  private restore(index: number): Promise<ServerResponse> {
    return this.enqueue(async () => {
      if (!Number.isInteger(index) || index < 0 || index >= this.history.length)
        throw new Error('没有可恢复的历史状态。')
      const result = await kernelService.rebuild(this.history[index])
      this.position = index
      this.publish(result)
      return { result: true, maxLevel: 0, messages: [] }
    })
  }
  requestByName(name: string, command?: ServerRequest): Promise<ServerResponse> {
    return this.request(command || { command: name })
  }
  protected async request(command: ServerRequest): Promise<ServerResponse> {
    if (command.command === 'GetTree')
      return { result: toStructure(this.document, this.view, this.latestResult), maxLevel: 0, messages: [] }
    if (command.command === 'Execute' && Array.isArray(command.task)) {
      let result: unknown = true
      try {
        for (const task of command.task) {
          for (const [name, args] of Object.entries(task)) {
            result = await this.enqueue(async () => {
              const params = Array.isArray(args) ? args[0] : args
              if (name === 'v1.common.save') {
                const p = params as any
                if (p.format !== 'STP' && p.format !== 'STEP') throw new Error('本地导出支持 occt.json 和 STEP。')
                const source = await kernelService.exportStep(this.history[this.draftPosition ?? this.position]),
                  bytes = new TextEncoder().encode(source)
                let binary = ''
                for (const byte of bytes) binary += String.fromCharCode(byte)
                return { content: p.encoding === 'base64' ? btoa(binary) : source }
              }
              if (name === 'v1.assembly.startMovingUnderConstraints') {
                const p = params as any
                const ids = this.document.assembly?.instances.map(i => i.id) || []
                if (!p.instanceIds?.length || p.instanceIds.some((id: number) => !ids.includes(id)))
                  throw new Error('请选择要移动的实例。')
                if (this.draftPosition !== undefined) throw new Error('请先应用或关闭当前编辑，再拖动零件。')
                this.moving = { ids: p.instanceIds, document: this.document, position: this.position }
                return true
              }
              if (name === 'v1.assembly.finishMovingUnderConstraints') {
                this.moving = undefined
                if (useOcct.getState().liveInterference && this.document.assembly)
                  void this.analysis.flush().catch(() => undefined)
                return true
              }
              if (name === 'v1.assembly.moveUnderConstraints') {
                if (!this.moving) throw new Error('实例移动尚未开始。')
                const p = params as any,
                  next = structuredClone(this.moving.document)
                const delta = new Matrix4()
                if (p.rotation)
                  delta.makeBasis(
                    new Vector3(...p.rotation.xDir),
                    new Vector3(...p.rotation.yDir),
                    new Vector3(...p.rotation.zDir),
                  )
                if (p.offset) delta.setPosition(...(p.offset as [number, number, number]))
                next
                  .assembly!.instances.filter(i => this.moving!.ids.includes(i.id))
                  .forEach(i => {
                    i.csys = matrixCSys(delta.clone().multiply(csysMatrix(i.csys)))
                  })
                const current = this.document
                useOcct.setState({ guardingMove: true, motionError: '' })
                try {
                  // The target remains private until OCCT has checked its entire path from the last accepted pose.
                  const accepted = await kernelService.guardMove(current, validateDocument(next))
                  if (this.closed) throw new Error('模型已经关闭。')
                  if (
                    JSON.stringify(accepted.document.assembly!.instances) !==
                    JSON.stringify(current.assembly!.instances)
                  ) {
                    this.history = [
                      ...this.history.slice(0, this.moving.position + 1),
                      this.solved(accepted.document, accepted.result),
                    ]
                    this.position = this.moving.position + 1
                    this.publish(accepted.result, true)
                  }
                  useOcct.setState({ motionBlock: accepted.block })
                  return true
                } catch (error) {
                  this.analysisState({
                    motionBlock: undefined,
                    motionError: error instanceof Error ? error.message : String(error),
                  })
                  throw error
                } finally {
                  this.analysisState({ guardingMove: false })
                }
              }
              if (name === 'v1.part.closeFeature' && this.draftPosition !== undefined) {
                this.position = this.draftPosition
                this.history = this.history.slice(0, this.position + 1)
                this.draftPosition = undefined
                this.publish(await kernelService.rebuild(this.document))
                return true
              }
              const edit = nativeCommand(name, params, this.document, this.view, this.latestResult)
              if (edit.view) {
                this.view = edit.view
                this.publish(this.latestResult || (await kernelService.rebuild(this.document)))
              }
              if (edit.document) {
                const document = validateDocument(edit.document)
                const rebuilt = await kernelService.rebuild(document, edit.drive)
                this.recordRevision(document)
                this.solved(document, rebuilt)
                if (name === 'v1.part.create' || name === 'v1.assembly.create') {
                  // A fresh document has no undo state pointing to another document type.
                  this.history = [document]
                  this.position = 0
                  this.draftPosition = undefined
                  this.view = rootView()
                } else if (
                  (name === 'v1.part.updateExtrusion' ||
                    name === 'v1.part.updateBoolean' ||
                    name === 'v1.part.updateImportFeature' ||
                    name.startsWith('v1.assembly.update')) &&
                  this.draftPosition !== undefined
                ) {
                  this.history[this.position] = document
                  this.draftPosition = undefined
                } else {
                  if (name === 'v1.part.createUncommitedObject' || name === 'v1.assembly.createUncommitedObject')
                    this.draftPosition = this.position
                  this.history = [...this.history.slice(0, this.position + 1), document]
                  this.position++
                }
                this.publish(rebuilt)
              }
              return edit.result
            })
          }
        }
        return { result, maxLevel: 0, messages: [] } as unknown as ServerResponse
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          result: null,
          maxLevel: 51,
          messages: [{ level: 51, message, code: 1, api: 'OCCT' }],
        } as unknown as ServerResponse
      }
    }
    throw new Error(`OCCT 原型暂不支持 ${command.command}。`)
  }
}
