import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

const platform = process.argv.slice(2).filter((arg) => arg !== '--')[0] ?? 'linux/amd64'
if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('支持的平台：linux/amd64、linux/arm64')
const root = resolve(import.meta.dir, '..')
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()
const tag = `${stamp}-${platform.split('/')[1]}`
const image = `ineffa:${tag}`
const directory = join(root, 'release', `ineffa-${tag}`)

async function docker(args: string[]) {
  const child = Bun.spawn(['docker', ...args], { cwd: root, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
  if (await child.exited) throw new Error(`docker ${args[0]} 失败。`)
}

await docker(['build', '--platform', platform, '--tag', image, '.'])
await mkdir(directory, { recursive: true })
const archive = join(directory, 'ineffa-image.tar.gz')
const child = Bun.spawn(['docker', 'image', 'save', image], { stdout: 'pipe', stderr: 'inherit' })
try {
  await pipeline(
    Readable.fromWeb(child.stdout as unknown as Parameters<typeof Readable.fromWeb>[0]),
    createGzip(),
    createWriteStream(archive)
  )
} catch (error) {
  child.kill()
  await child.exited
  throw error
}
if (await child.exited) throw new Error('镜像导出失败。')
await copyFile(join(root, 'deploy', 'compose.yaml'), join(directory, 'compose.yaml'))
await writeFile(
  join(directory, '.env'),
  [`INEFFA_IMAGE=${image}`, `INEFFA_TOKEN=${randomBytes(32).toString('hex')}`, 'INEFFA_PORT=4097', ''].join('\n'),
  { mode: 0o600 }
)
await writeFile(
  join(directory, 'README.txt'),
  `Ineffa · ${platform}

将此文件夹完整复制到安装了 Docker 和 Docker Compose 的目标机器（包含 .env 隐藏文件）。
在该文件夹执行：

docker load -i ineffa-image.tar.gz
docker compose up -d

打开 http://127.0.0.1:4097，使用 .env 中的 INEFFA_TOKEN 登录。
在 WebUI 配置模型和平台账号，工作目录使用 /app/workspace。
默认只允许本机访问。远程服务器可通过 SSH 转发：
ssh -L 4097:127.0.0.1:4097 用户@服务器

查看状态：docker compose ps
查看日志：docker compose logs -f
停止服务：docker compose down
更新：导入新镜像，在原部署目录 .env 中仅更新 INEFFA_IMAGE，再执行 docker compose up -d。
不要用新包的 .env 覆盖原部署配置；不要执行 docker compose down -v，否则会删除数据卷。

两个数据卷分别保存账号/凭据/会话与工作文件，普通重建和重启会保留。
镜像不包含当前机器上的账号、密钥、会话或工作文件；这些不会随镜像迁移。
镜像构建和启动均无需公开仓库，运行模型和 KOOK 仍需网络访问。
`
)
console.log(`\n镜像：${image}\n本地部署包：${directory}`)
