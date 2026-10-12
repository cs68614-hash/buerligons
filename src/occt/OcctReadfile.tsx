import React from 'react'
import { BuerliCadFacade } from '@buerli.io/classcad'
import { api as buerliApi, getDrawing } from '@buerli.io/core'
import { message } from 'antd'
import { parseDocument } from './model'
import { useOcct } from './OcctClient'
import { importStepDocument } from './stepDocument'

/** File input used inside the original welcome screen and File menu. */
export const OcctReadfile = React.forwardRef<HTMLInputElement>((_, ref) => (
  <input
    ref={ref}
    type="file"
    accept=".json,.occt.json,.stp,.step"
    style={{ display: 'none' }}
    onChange={async event => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      try {
        if (file.size > 32 * 1024 * 1024) throw new Error('请选择不超过 32 MB 的本地工程或 STEP 文件。')
        const source = await file.text(),
          document = /\.(stp|step)$/i.test(file.name) ? importStepDocument(file.name, source) : parseDocument(source)
        const drawingId = buerliApi.getState().drawing.active || (await BuerliCadFacade.utils.connect('Part'))
        if (!drawingId) throw new Error('无法打开模型。')
        const client = useOcct.getState().client
        if (!client) throw new Error('OCCT 尚未加载。')
        getDrawing(drawingId).api.plugin.setActiveFeature(null)
        await client.replace(document)
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error))
      }
    }}
  />
))

OcctReadfile.displayName = 'OcctReadfile'
