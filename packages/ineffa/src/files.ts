import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Attachment } from './types'

/** Snapshot the bytes before persisting delivery, so a retry cannot send a changed file. */
export async function snapshotFile(directory: string, path: string, storageDirectory: string): Promise<Attachment> {
  const root = await realpath(directory)
  const target = await realpath(resolve(root, path))
  const local = relative(root, target)
  if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) {
    throw new Error('只能发送当前账号工作目录内的文件。')
  }
  const info = await stat(target)
  if (!info.isFile()) throw new Error('发送目标必须是文件。')
  if (info.size > 20 * 1024 * 1024) throw new Error('附件超过 20 MiB。')
  const file = Bun.file(target)
  const bytes = await file.bytes()
  if (bytes.length > 20 * 1024 * 1024) throw new Error('附件超过 20 MiB。')
  const mime = file.type || 'application/octet-stream'
  const folder = join(storageDirectory, createHash('sha256').update(bytes).digest('hex'))
  await mkdir(folder, { recursive: true })
  const snapshot = join(folder, basename(target))
  const temporary = `${snapshot}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
  try {
    await rename(temporary, snapshot)
  } finally {
    await rm(temporary, { force: true })
  }
  return { uri: pathToFileURL(snapshot).href, name: basename(target), mime }
}
