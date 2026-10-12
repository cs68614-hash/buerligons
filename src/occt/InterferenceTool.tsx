import React from 'react'
import { DrawingID } from '@buerli.io/core'
import { useDrawing } from '@buerli.io/react'
import { Alert, Button, Drawer, Empty, Space, Switch, Tooltip } from 'antd'
import { ScanOutlined } from '@ant-design/icons'
import { useOcct } from './OcctClient'
import './interference.css'

const blockMessage = {
  contact: '碰到其他零件，已停住。',
  initialOverlap: '起始位置已有干涉，保持原位；请先调整约束或零件尺寸。',
  budget: '路径计算达到预算，停在最后一个已确认安全的位置。',
  constraintPath: '受现有约束限制，无法确认中间位置有效，保持原位。',
}

/** Uses Drawing's existing Trail slot; all original modelling tools remain in place. */
export function InterferenceTool({ drawingId }: { drawingId: DrawingID }) {
  const [open, setOpen] = React.useState(false)
  const client = useOcct(s => s.client),
    doc = useOcct(s => s.document),
    report = useOcct(s => s.interference)
  const busy = useOcct(s => s.busy),
    checking = useOcct(s => s.checkingInterference)
  const selection = useOcct(s => s.interferenceSelection),
    live = useOcct(s => s.liveInterference),
    error = useOcct(s => s.interferenceError)
  const guarding = useOcct(s => s.guardingMove),
    block = useOcct(s => s.motionBlock),
    motionError = useOcct(s => s.motionError)
  const currentProduct = useDrawing(drawingId, d => d.structure.currentProduct)
  const isAssembly = doc.kind === 'assembly' && currentProduct === 1
  const check = async () => {
    setOpen(true)
    useOcct.setState({ interferenceError: '' })
    try {
      await client?.checkInterference()
    } catch (err) {
      useOcct.setState({ interferenceError: err instanceof Error ? err.message : String(err) })
    }
  }
  const close = () => {
    setOpen(false)
    if (!live) useOcct.setState({ interferenceSelection: 'hidden' })
  }
  React.useEffect(() => {
    if (!isAssembly) setOpen(false)
  }, [isAssembly])
  if (!isAssembly) return null
  return (
    <>
      <Tooltip title="装配干涉检查">
        <button
          type="button"
          className="rcad-tool"
          aria-label="装配干涉检查"
          onClick={() => {
            if (report || checking || live) {
              setOpen(true)
              useOcct.setState({ interferenceSelection: undefined })
            } else void check()
          }}>
          <ScanOutlined />
        </button>
      </Tooltip>
      {(live || guarding || block || motionError) && (
        <button
          type="button"
          className={`occt-interference-status ${block || motionError || report?.overlaps.length ? 'collision' : ''}`}
          onClick={() => setOpen(true)}
          aria-label="实时干涉状态">
          <span role="status" aria-live="polite">
            {guarding
              ? '防穿透：检查路径…'
              : motionError
              ? '防穿透：计算失败，保持原位'
              : block
              ? block.reason === 'contact'
                ? '防穿透：已停住'
                : '防穿透：路径受限'
              : checking
              ? '实时：检查中…'
              : error || report?.errors.length
              ? '实时：检查未完成'
              : report?.overlaps.length
              ? `实时：${report.overlaps.length} 对碰撞`
              : report?.checkedPairs
              ? '实时：未发现干涉'
              : '实时：等待实体零件'}
          </span>
        </button>
      )}
      <Drawer
        title="装配干涉检查"
        placement="right"
        width={360}
        open={open}
        mask={false}
        onClose={close}
        className="occt-interference"
        getContainer={() => document.querySelector('[data-rcad-root]') as HTMLElement}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Space>
            <Switch
              checked={live}
              onChange={enabled => client?.setLiveInterference(enabled)}
              aria-label="实时干涉检查"
            />
            <span>实时干涉检查</span>
          </Space>
          <Button onClick={() => void check()} loading={checking} disabled={busy || checking}>
            重新检查
          </Button>
          <p>拖动零件或更新约束后自动检查，碰撞处显示红色实体交集。检查包含隐藏零件；关闭此面板仍持续检查。</p>
          <small>
            拖动先检查连续运动路径，遇到障碍停住；防穿透始终开启，独立于实时干涉开关。约束数值和尺寸修改仍会求解，并显示实际干涉。
          </small>
          {guarding && <Alert type="info" message="正在检查移动路径，视图保持上一个安全位置…" />}
          {motionError && (
            <Alert type="error" showIcon message="无法确认安全路径，移动未提交。" description={motionError} />
          )}
          {block && (
            <Alert
              type="warning"
              showIcon
              message={blockMessage[block.reason]}
              description={
                <>
                  {block.contacts.map((contact, i) => (
                    <div key={i}>{contact.names.join(' ↔ ')}</div>
                  ))}
                  {block.reason === 'contact' && (
                    <small>红色标记表示最近接触点；停止间隙约 {block.clearance} mm，接触不等于体积干涉。</small>
                  )}
                </>
              }
            />
          )}
          {error && <Alert type="error" showIcon message={error} />}
          {checking && <Alert type="info" message="本地 OCCT 正在计算…" />}
          {!checking && !report && !error && <Empty description="尚无有效结果；开启实时检查或点击重新检查。" />}
          {report && !checking && (
            <>
              <Alert
                showIcon
                type={
                  report.errors.length
                    ? 'warning'
                    : report.overlaps.length
                    ? 'error'
                    : report.checkedPairs
                    ? 'success'
                    : 'info'
                }
                message={
                  report.errors.length
                    ? '检查未完成，不能判定整个装配无干涉。'
                    : report.overlaps.length
                    ? `发现 ${report.overlaps.length} 对干涉零件`
                    : !report.checkedPairs
                    ? '没有可检查的实体零件对'
                    : report.ignoredInstances.length
                    ? '已检查的实体零件未发现干涉'
                    : '未发现体积干涉'
                }
              />
              <div>
                已检查 {report.checkedPairs} / {report.totalPairs} 对；忽略 {report.ignoredInstances.length}{' '}
                个无实体实例。
              </div>
              <small>面、边接触不算干涉；重叠体积阈值 {report.volumeTolerance} mm³。每对体积单独计算。</small>
              {!!report.overlaps.length && (
                <>
                  <Space>
                    <Button size="small" onClick={() => useOcct.setState({ interferenceSelection: undefined })}>
                      显示全部
                    </Button>
                    <Button size="small" onClick={() => useOcct.setState({ interferenceSelection: 'hidden' })}>
                      清除高亮
                    </Button>
                  </Space>
                  {report.overlaps.map(pair => (
                    <button
                      key={pair.id}
                      type="button"
                      className="occt-interference-pair"
                      aria-pressed={selection === pair.id}
                      onClick={() =>
                        useOcct.setState(s => ({
                          interferenceSelection: pair.id,
                          interferenceFocus: s.interferenceFocus + 1,
                        }))
                      }>
                      <strong>
                        {pair.names[0]} ↔ {pair.names[1]}
                      </strong>
                      <span>
                        {pair.volume.toLocaleString(undefined, { maximumSignificantDigits: 8 })} mm³ · 点击定位
                      </span>
                    </button>
                  ))}
                </>
              )}
              {report.errors.map((issue, index) => (
                <Alert
                  key={index}
                  type="warning"
                  showIcon
                  message={issue.instanceIds
                    .map(id => doc.assembly?.instances.find(i => i.id === id)?.name || id)
                    .join(' ↔ ')}
                  description={issue.message}
                />
              ))}
              {report.ignoredInstances.map(i => (
                <div key={i.id}>
                  {i.name}：{i.reason}
                </div>
              ))}
            </>
          )}
        </Space>
      </Drawer>
    </>
  )
}
