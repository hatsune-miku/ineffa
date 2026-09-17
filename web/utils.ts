export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
export function timeOf(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(value)
}
