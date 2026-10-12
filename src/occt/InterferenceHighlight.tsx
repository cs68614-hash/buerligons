import React from 'react'
import { BufferGeometry, Float32BufferAttribute, EdgesGeometry, DoubleSide, Box3, Vector3 } from 'three'
import { useBounds } from '@react-three/drei'
import { HUD } from '@buerli.io/react-cad'
import { useThree } from '@react-three/fiber'
import { useOcct } from './OcctClient'
import { InterferenceRegion } from './model'

function Region({ region }: { region: InterferenceRegion }) {
  const geometry = React.useMemo(() => {
    const positions: number[] = [],
      indices: number[] = []
    for (const face of region.geometry.meshes) {
      const offset = positions.length / 3
      positions.push(...face.vertices)
      indices.push(...face.indices.map(i => i + offset))
    }
    const mesh = new BufferGeometry()
    mesh.setAttribute('position', new Float32BufferAttribute(positions, 3))
    mesh.setIndex(indices)
    return mesh
  }, [region])
  const edges = React.useMemo(() => new EdgesGeometry(geometry, 20), [geometry])
  React.useEffect(
    () => () => {
      geometry.dispose()
      edges.dispose()
    },
    [geometry, edges],
  )
  return (
    <group>
      <mesh geometry={geometry} raycast={() => null} renderOrder={-1000}>
        <meshBasicMaterial
          color="#ff173b"
          transparent
          opacity={0.35}
          side={DoubleSide}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <lineSegments geometry={edges} raycast={() => null} renderOrder={-999}>
        <lineBasicMaterial color="#ff002b" transparent depthTest={false} depthWrite={false} toneMapped={false} />
      </lineSegments>
    </group>
  )
}

/** Native HUD renders after the existing composer, revealing buried overlap without changing part materials. */
export function InterferenceHighlight() {
  const report = useOcct(s => s.interference),
    selected = useOcct(s => s.interferenceSelection),
    focus = useOcct(s => s.interferenceFocus),
    block = useOcct(s => s.motionBlock)
  const bounds = useBounds(),
    invalidate = useThree(s => s.invalidate),
    camera = useThree(s => s.camera)
  const handledFocus = React.useRef(focus)
  const region = report?.overlaps.find(p => p.id === selected)
  React.useEffect(() => {
    if (handledFocus.current === focus) return
    handledFocus.current = focus
    if (region) {
      const box = new Box3(new Vector3(...region.geometry.min), new Vector3(...region.geometry.max))
      // Keep camera orientation, centre on the actual overlap with room for neighbouring geometry.
      box.expandByScalar(Math.max(3, box.getSize(new Vector3()).length() * 0.5))
      bounds.refresh(box)
      const { center, distance } = bounds.getSize()
      const position = center.clone().addScaledVector(camera.getWorldDirection(new Vector3()), -distance)
      bounds.moveTo(position).lookAt({ target: center, up: camera.up }).fit().clip()
    }
  }, [region, focus, bounds, camera])
  React.useEffect(() => {
    invalidate()
  }, [report, selected, block, invalidate])
  const contacts = block?.reason === 'contact' ? block.contacts : []
  const regions =
    !report || selected === 'hidden' ? [] : selected ? report.overlaps.filter(p => p.id === selected) : report.overlaps
  if (!regions.length && !contacts.length) return null
  return (
    <HUD>
      {contacts.map(contact => (
        <group key={contact.instanceIds.join('-')}>
          {contact.points.map((p, i) => (
            <mesh key={i} position={new Vector3(...p)} raycast={() => null} renderOrder={-998}>
              <sphereGeometry args={[0.3, 12, 8]} />
              <meshBasicMaterial color="#ff173b" transparent depthTest={false} depthWrite={false} toneMapped={false} />
            </mesh>
          ))}
        </group>
      ))}
      {regions.map(p => (
        <Region key={p.id} region={p} />
      ))}
    </HUD>
  )
}
