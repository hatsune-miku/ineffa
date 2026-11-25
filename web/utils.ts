export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
export function platformName(platform: string) {
  return (
    ({ kook: 'KOOK', feishu: '飞书', lark: 'Lark', web: '个人空间' } as Record<string, string>)[platform] ?? platform
  )
}
export function timeOf(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(value)
}
