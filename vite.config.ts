/* eslint-disable @typescript-eslint/ban-ts-comment */
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, Plugin } from 'vite'
// @ts-ignore
import checker from 'vite-plugin-checker'
import svgrPlugin from 'vite-plugin-svgr'
import viteTsconfigPaths from 'vite-tsconfig-paths'
import { readFileSync } from 'node:fs'

// Keep the native Product Management / Import button; adapt only its file protocol.
function nativeOcctImport(code: string): string {
  const start = code.indexOf('const ImportModel = ({'),
    end = code.indexOf('const RootImpl$1 = ({', start)
  if (start < 0 || end < 0) throw new Error('Native Import component changed; update the OCCT file adapter.')
  const component = code
    .slice(start, end)
    .replace(
      "const format = type === 'STEP' ? 'STP' : type;",
      "const format = type === 'JSON' ? 'OCCT_JSON' : type === 'STEP' ? 'STP' : type;",
    )
    .replace("['OFB', 'STP'].includes(format)", "['OCCT_JSON', 'STP'].includes(format)")
    .replace("'.ofb,.stp,.step'", "'.occt.json,.json,.stp,.step'")
  const adapted = nativeOcctMates(code.slice(0, start) + component + code.slice(end))
  // Preserve the native Apply button, including accepting an unchanged new feature.
  const original = 'const updateDisabled = !(smthChanged || forceUpdateEnabled);'
  if (!adapted.includes(original)) throw new Error('Native Apply behavior changed; update the OCCT draft adapter.')
  return adapted
    .replace(
      "isSolved ? 'Solved' : 'Not solved'",
      "isSolved ? (solverStateMemb.members[0].value > 0 ? solverStateMemb.members[0].value + ' DOF' : 'Fully constrained') : 'Not solved'",
    )
    .replace(
      original,
      `const draftId = usePlugin(drawingId, pluginId, p => p.objectId);
  const uncommited = useIsUncommited(drawingId, draftId);
  const isDraft = uncommited && ['CC_Extrusion', 'CC_Union', 'CC_Subtraction', 'CC_Intersection'].includes(getDrawing(drawingId).structure.tree[draftId]?.class);
  const updateDisabled = !(smthChanged || forceUpdateEnabled || isDraft);`,
    )
}
// Keep native mate editors. Convert analytic face picks into their existing mate protocol.
function nativeOcctMates(code: string): string {
  const start = code.indexOf('const MateEditor = ({'),
    end = code.indexOf('const MateRestorer = ({', start)
  if (start < 0 || end < 0) throw new Error('Native mate editor changed; update the OCCT face adapter.')
  const helper = `const occtFaceMateItem = (drawingId, item, caption) => {
    if (!item || item.scope !== BuerliScope) return item;
    const drawing = getDrawing(drawingId);
    const csys = Object.values(drawing.structure.tree).find(o => o.members?.occtFaceGraphicId?.value === item.data.graphicId);
    if (!csys) return undefined;
    const plugin = drawing.plugin.refs[drawing.plugin.active.feature];
    const isContact = drawing.structure.tree[plugin?.objectId]?.class === 'CC_PlanarConstraint';
    const flip = isContact && caption === 'Second mate' ? FlipType.FLIP_Z_INV : FlipType.FLIP_Z;
    return createMateItem(getMatePath(drawingId, item.data.productId), csys, flip, ReorientedType.REORIENTED_0);
  };
`
  const context =
    'drawingId,\n    includeSelected,\n    activeRigidsets\n  } = React__default.useContext(CSysDisplayContext);'
  if (!code.includes(context)) throw new Error('Native mate context changed; update the face adapter.')
  code = code.replace(
    context,
    'drawingId,\n    includeSelected,\n    activeRigidsets,\n    selItems\n  } = React__default.useContext(CSysDisplayContext);',
  )
  let editor = code
    .slice(start, end)
    .replace(
      'const path_ = selItem == null',
      'selItem = occtFaceMateItem(drawingId, selItem, caption);\n    const path_ = selItem == null',
    )
    .replace('}, [setUserValue]);', '}, [setUserValue, drawingId, caption]);')
    .replace(
      'const onHover = React__default.useCallback(item => {',
      'const onHover = React__default.useCallback(item => {\n    item = occtFaceMateItem(drawingId, item, caption);',
    )
    .replace('}, [drawingId]);', '}, [drawingId, caption]);')
    .replace(
      'filter: mateFilter,',
      `filter: (scope, data) => { const drawing = getDrawing(drawingId); const type = drawing.structure.tree[drawing.plugin.refs[drawing.plugin.active.feature]?.objectId]?.class; const types = type === 'CC_PlanarConstraint' ? [ScgGraphicType.PLANE] : type === 'CC_CylindricalConstraint' ? [ScgGraphicType.CYLINDER] : [ScgGraphicType.PLANE, ScgGraphicType.CYLINDER]; return mateFilter(scope, data) || scope === BuerliScope && types.includes(data); },`,
    )
  // Generated face frames become visible only while selected, keeping the original viewport uncluttered.
  const nativeFrames = 'const wcsysIds = geomSetChildren.filter(id => {'
  const adapted = code.slice(0, start) + helper + editor + code.slice(end)
  if (!adapted.includes(nativeFrames)) throw new Error('Native mate display changed; update the face adapter.')
  return adapted
    .replace("label: 'MATE'", "label: csys.members?.occtFaceGraphicId ? csys.name : 'MATE'")
    .replace('}, [drawingId, geomSetChildren, path]);', '}, [drawingId, geomSetChildren, path, selItems]);')
    .replace(
      nativeFrames,
      `const pickedFrames = selItems.filter(item => item.data.path.toString() === path.toString()).map(item => item.data.csys.id);
    const wcsysIds = [...new Set([...geomSetChildren, ...pickedFrames])].filter(id => {`,
    )
}

const nativeOcctFiles = (): Plugin => ({
  name: 'native-occt-files',
  transform(code, id) {
    if (id.endsWith('/@buerli.io/react-cad/build/index.js')) return { code: nativeOcctImport(code), map: null }
    if (id.endsWith('/BuerliCadFacade.js'))
      return { code: code.replace('Connected to ClassCAD', 'Local OCCT ready'), map: null }
  },
})

// Troika 0.47's font loader does not complete data-URL XHRs (status 0).
// Serve the native editor's exact embedded font bytes as a local build asset.
const localNativeDimensionFont = (): Plugin => ({
  name: 'local-native-dimension-font',
  apply: 'build',
  transform(code, id) {
    if (!id.endsWith('/@buerli.io/react-cad/build/index.js')) return
    const match = code.match(/const monoStage = ((?:'[^']*'\s*\+?\s*)+);/)
    if (!match) throw new Error('Native dimension font declaration changed; update the local-font adapter.')
    const dataUrl = [...match[1].matchAll(/'([^']*)'/g)].map(chunk => chunk[1]).join('')
    const source = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    const reference = this.emitFile({ type: 'asset', name: 'native-dimension-font.woff', source })
    return { code: code.replace(match[0], `const monoStage = import.meta.ROLLUP_FILE_URL_${reference};`), map: null }
  },
})

// https://vitejs.dev/config/
export default ({ mode }: { mode: string }) => {
  // Mode-specific env files (.env.<mode>) overlay .env — e.g. `vite --mode cli`
  // additionally loads .env.cli. Used instead of inline VAR=... env prefixes,
  // which do not work on Windows (cmd.exe).
  const env = loadEnv(mode, process.cwd(), '')

  return defineConfig({
    resolve: {
      dedupe: ['three', '@react-three/fiber', '@react-three/drei', 'react', 'react-dom'],
    },
    define: {
      CLASSCAD_WASM_KEY: JSON.stringify(mode === 'occt' ? '' : env.CLASSCAD_WASM_KEY ?? ''),
      SOCKETIO_URL: JSON.stringify(mode === 'occt' ? '' : env.SOCKETIO_URL ?? ''),
      WSCLIENT_URL: JSON.stringify(mode === 'occt' ? '' : env.WSCLIENT_URL ?? ''),
    },
    build: {
      outDir: './build',
    },
    optimizeDeps:
      mode === 'occt'
        ? {
            esbuildOptions: {
              plugins: [
                {
                  name: 'native-occt-files',
                  setup(build) {
                    build.onLoad({ filter: /@buerli\.io\/react-cad\/build\/index\.js$/ }, args => ({
                      contents: nativeOcctImport(readFileSync(args.path, 'utf8')),
                      loader: 'js',
                    }))
                    build.onLoad({ filter: /@buerli\.io\/classcad\/build\/.*\/BuerliCadFacade\.js$/ }, args => ({
                      contents: readFileSync(args.path, 'utf8').replace('Connected to ClassCAD', 'Local OCCT ready'),
                      loader: 'js',
                    }))
                  },
                },
              ],
            },
          }
        : undefined,
    plugins: [
      react(),
      ...(mode === 'occt' ? [nativeOcctFiles(), localNativeDimensionFont()] : []),
      checker({
        overlay: { initialIsOpen: false },
        typescript: true,
        eslint: {
          lintCommand: 'eslint "./src/**/*.{ts,tsx}"',
        },
      }),
      viteTsconfigPaths(),
      svgrPlugin(),
    ],
    css: {
      preprocessorOptions: {
        less: {
          math: 'always',
          relativeUrls: true,
          javascriptEnabled: true,
        },
      },
    },
  })
}
