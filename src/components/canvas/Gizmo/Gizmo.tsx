import React from 'react'
import * as THREE from 'three'

import { createApi } from '@buerli.io/classcad'
import { DrawingID, getDrawing, ObjectID } from '@buerli.io/core'
import { GlobalTransform } from '@buerli.io/react'
import { HUD } from '@buerli.io/react-cad'
import { PivotControls } from '@react-three/drei'

import { findInteractableParent } from './utils'
import { DragSequence } from './DragSequence'

export const Gizmo: React.FC<{ drawingId: DrawingID; productId: ObjectID; matrix: THREE.Matrix4 }> = ({
  drawingId,
  productId,
  matrix,
}) => {
  const dragInfo = React.useRef<{ mPInv: THREE.Matrix4; mL0CInv: THREE.Matrix4 } | null>(null)
  const sequence = React.useRef<DragSequence<THREE.Matrix4>>()
  const finished = React.useRef<Promise<void>>(Promise.resolve())
  const isBlocked = React.useRef<boolean>(false)

  const { position, rotation } = React.useMemo(() => {
    return {
      position: new THREE.Vector3().setFromMatrixPosition(matrix).toArray(),
      rotation: new THREE.Euler().setFromRotationMatrix(matrix).toArray() as [number, number, number],
    }
  }, [matrix])

  const onDragStart = React.useCallback(
    ({ component }: { component: 'Arrow' | 'Slider' | 'Rotator' }) => {
      if (isBlocked.current) {
        return
      }

      const drawing = getDrawing(drawingId)
      const curProdId = drawing.structure.currentProduct
      const curInstanceId = drawing.structure.currentInstance
      const draggedInstanceId = findInteractableParent(drawingId, productId)
      if (!curProdId || !curInstanceId || !draggedInstanceId || !productId) {
        return
      }

      const mP = drawing.api.structure.calculateGlobalTransformation(curInstanceId)
      const mPInv = mP.clone().invert()
      const mL0C = drawing.api.structure.calculateGlobalTransformation(productId).premultiply(mPInv)
      const mL0CInv = mL0C.invert()

      const pivotPos = new THREE.Vector3(...position).applyMatrix4(mL0C).toArray()
      const mucType = component === 'Arrow' ? 'TRANSLATION_1D' : component === 'Slider' ? 'TRANSLATION_2D' : 'ROTATION'

      const selected = drawing.interaction.selected || []
      const selectedRefs = selected.map(obj =>
        obj.prodRefId ? findInteractableParent(drawingId, obj.prodRefId) : null,
      )
      const selectedRefsUnique = selectedRefs.filter(
        (refId, id) => refId && id === selectedRefs.indexOf(refId),
      ) as ObjectID[]
      const draggedInstances = selectedRefsUnique.map(
        id => (drawing.structure.tree[id].members?.productRef?.value || id) as ObjectID,
      )

      dragInfo.current = { mPInv, mL0CInv }
      const api = createApi(drawingId).v1.assembly
      const started = finished.current.then(() =>
        api.startMovingUnderConstraints({
          id: curProdId,
          instanceIds: draggedInstances,
          pivotInfo: pivotPos,
          mucType,
        }),
      )
      sequence.current = new DragSequence(
        started,
        async delta => {
          const e = delta.elements
          await api.moveUnderConstraints({
            id: curProdId,
            rotation: { xDir: e.slice(0, 3), yDir: e.slice(4, 7), zDir: e.slice(8, 11) },
            offset: e.slice(12, 15),
          })
        },
        () => api.finishMovingUnderConstraints({ id: curProdId }),
      )
    },
    [drawingId, productId, position],
  )

  const onDrag = React.useCallback(
    (l: THREE.Matrix4, deltaL: THREE.Matrix4, w: THREE.Matrix4, deltaW: THREE.Matrix4) => {
      if (!dragInfo.current) {
        return
      }

      const delta = dragInfo.current.mPInv.clone().multiply(w).multiply(dragInfo.current.mL0CInv)
      sequence.current?.update(delta)
    },
    [],
  )

  const onDragEnd = React.useCallback(() => {
    if (!dragInfo.current) {
      return
    }

    dragInfo.current = null
    finished.current = sequence.current!.finish().catch(console.warn)
  }, [])

  React.useEffect(() => {
    const handleKey = (e: KeyboardEvent) => (isBlocked.current = e.shiftKey)

    window.addEventListener('keydown', handleKey)
    window.addEventListener('keyup', handleKey)

    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('keyup', handleKey)
      void sequence.current?.finish().catch(console.warn)
    }
  }, [])

  return (
    <HUD>
      <GlobalTransform drawingId={drawingId} objectId={productId}>
        <PivotControls
          scale={96}
          lineWidth={5}
          fixed
          onDragStart={onDragStart}
          onDrag={onDrag}
          onDragEnd={onDragEnd}
          offset={position}
          rotation={rotation}
          autoTransform={false}
          userData={{ onHUD: true }}
          annotations={false}
        />
      </GlobalTransform>
    </HUD>
  )
}
