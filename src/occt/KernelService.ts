import { CadDocument, KernelResult, InterferenceReport, CoordinateSystem, GuardedMoveResult } from './model'
import type { MotionDrive } from './assemblySolver'

class KernelService {
  private worker: Worker | undefined
  private nextId = 0
  private pending = new Map<
    number,
    { resolve: (r: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()

  rebuild(document: CadDocument, drive?: MotionDrive): Promise<KernelResult> {
    return this.request(document, drive, 'rebuild')
  }
  guardMove(start: CadDocument, target: CadDocument): Promise<GuardedMoveResult> {
    return this.request(target, undefined, 'guardMove', undefined, start)
  }
  checkInterference(document: CadDocument, poses?: Record<number, CoordinateSystem>): Promise<InterferenceReport> {
    return this.request(document, undefined, 'interference', poses)
  }
  exportStep(document: CadDocument): Promise<string> {
    return this.request(document, undefined, 'exportStep')
  }
  dispose(): void {
    this.fail(new Error('OCCT Worker 已关闭。'))
  }
  private request(
    document: CadDocument,
    drive: MotionDrive | undefined,
    action: string,
    poses?: Record<number, CoordinateSystem>,
    start?: CadDocument,
  ): Promise<any> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./kernel.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = ({ data }) => {
        const request = this.pending.get(data.id)
        if (!request) return
        clearTimeout(request.timer)
        this.pending.delete(data.id)
        if (data.error) request.reject(new Error(data.error))
        else request.resolve(data.result)
      }
      this.worker.onerror = () => this.fail(new Error('OCCT Worker 加载失败，请检查本地 WASM 文件。'))
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => this.fail(new Error('OCCT 计算超时，请重试。')), 60000)
      this.pending.set(id, { resolve, reject, timer })
      this.worker!.postMessage({ id, document, drive, action, poses, start })
    })
  }

  private fail(error: Error) {
    this.worker?.terminate()
    this.worker = undefined
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}
export const kernelService = new KernelService()

// Boolean inspection cannot block the worker that rebuilds interactive geometry.
export const interferenceService = new KernelService()
