import { Database } from 'bun:sqlite'
import { resolve } from 'node:path'

/** An OS-backed SQLite lock releases automatically even when the process crashes. */
export function acquireOwnership(dataDirectory: string) {
  const lock = new Database(resolve(dataDirectory, 'owner.sqlite'), { create: true })
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY);')
  } catch (error) {
    lock.close()
    throw new Error('无法独占 Ineffa 数据目录。请确认没有其他进程正在使用它。', { cause: error })
  }
  let closed = false
  return () => {
    if (closed) return
    closed = true
    lock.exec('ROLLBACK')
    lock.close()
  }
}
