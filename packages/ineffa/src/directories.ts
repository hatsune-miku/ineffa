export const directoryTools = {
  list_skills: 'skills',
  list_browser_tools: 'browser',
  list_coding_tools: 'coding',
  list_tools: 'generic',
} as const

export type DirectoryGroup = (typeof directoryTools)[keyof typeof directoryTools]

export function isDirectoryTool(name: string): name is keyof typeof directoryTools {
  return Object.hasOwn(directoryTools, name)
}
