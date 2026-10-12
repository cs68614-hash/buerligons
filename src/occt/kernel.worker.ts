import initOpenCascade from 'opencascade.js/dist/opencascade.wasm.js'
import wasmUrl from 'opencascade.js/dist/opencascade.wasm.wasm?url'
import { rebuild } from './kernel'
import { CadDocument, CoordinateSystem } from './model'
import type { MotionDrive } from './assemblySolver'
import { exportStep } from './engineeringKernel'
import { checkInterference } from './interference'
import { guardMove } from './continuousCollision'

// All runtime assets are served by Vite / the local static server, never a vendor CDN.
const kernel = initOpenCascade({ locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path) })
let queue = Promise.resolve()
self.onmessage = (
  event: MessageEvent<{
    id: number
    document: CadDocument
    drive?: MotionDrive
    start?: CadDocument
    action?: string
    poses?: Record<number, CoordinateSystem>
  }>,
) => {
  const { id, document, drive, action, poses, start } = event.data
  queue = queue.then(async () => {
    try {
      const oc = await kernel
      if (action === 'guardMove' && !start) throw new Error('防穿透缺少起始位置。')
      self.postMessage({
        id,
        result:
          action === 'guardMove'
            ? guardMove(oc, start!, document)
            : action === 'exportStep'
            ? exportStep(oc, document)
            : action === 'interference'
            ? checkInterference(oc, document, poses)
            : rebuild(oc, document, drive),
      })
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : `OCCT 计算失败：${String(error)}` })
    }
    return undefined
  })
}
