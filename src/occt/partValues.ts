export const numeric = (v: unknown, fallback?: number): number => {
  if (v === undefined && fallback !== undefined) return fallback
  const angular = String(v).trim().endsWith('deg'),
    n = typeof v === 'number' ? v : Number(String(v).replace(/\s*(mm|deg|rad)\s*$/, '')) * (angular ? Math.PI / 180 : 1)
  if (!Number.isFinite(n) || Math.abs(n) > 1e6) throw new Error('请输入有限数值尺寸；长度 mm，角度支持 deg。')
  return n
}
export const position = (p: any) => [
  numeric(Array.isArray(p) ? p[0] : p?.x),
  numeric(Array.isArray(p) ? p[1] : p?.y),
  numeric(Array.isArray(p) ? p[2] : p?.z, 0),
]
