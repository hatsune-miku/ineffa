import { useCallback, useEffect, useRef, useState } from 'react'

import { Alert, Badge, Button, CakeProvider, ContextMenu, MenuItem, TextBox } from '@a1knla/cakeui'

import { useAppearance } from './appearance'
import { Conversation } from './components/Conversation'
import { DeleteConversation } from './components/DeleteConversation'
import { Login } from './components/Login'
import { ManageConversation } from './components/ManageConversation'
import { NewConversation } from './components/NewConversation'
import { Settings } from './components/Settings'
import { ThemeControl } from './components/ThemeControl'

import { ApiError, type Catalog, type ConversationDetail, type Conversation as ConversationInfo, api } from '../api'
import { Icon } from '../components/Icon'
import { IconButton } from '../components/IconButton'
import { Loading } from '../components/Loading'
import { messageOf } from '../utils'

import './index.css'

function initialSelection() {
  return location.hash.startsWith('#session/') ? decodeURIComponent(location.hash.slice(9)) : ''
}

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [sessions, setSessions] = useState<ConversationInfo[]>([])
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [selected, setSelected] = useState(initialSelection)
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [search, setSearch] = useState('')
  const [showArchive, setShowArchive] = useState(false)
  const [sidebar, setSidebar] = useState(false)
  const [newDialog, setNewDialog] = useState(false)
  const [manage, setManage] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ConversationInfo | null>(null)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [revision, setRevision] = useState(0)
  const [live, setLive] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const { palette, mode, changePalette, changeMode } = useAppearance()
  const active = useRef(selected)
  const detailsRef = useRef(detail)
  const requestSeq = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  active.current = selected
  detailsRef.current = detail
  const loadCatalog = useCallback(async () => {
    setCatalog(await api<Catalog>('/catalog'))
  }, [])
  const refresh = useCallback(async () => {
    const id = active.current
    const sequence = ++requestSeq.current
    const [list, current] = await Promise.all([
      api<{ sessions: ConversationInfo[] }>(`/sessions?archived=${showArchive}`),
      id
        ? api<ConversationDetail>(`/sessions/${id}`).catch((error) => {
            if (error instanceof ApiError && error.status === 404) return null
            throw error
          })
        : Promise.resolve(null),
    ])
    if (sequence !== requestSeq.current) return
    setSessions(list.sessions)
    if (active.current === id) {
      setDetail(current)
      if (id && !current) {
        active.current = ''
        setSelected('')
        setManage(false)
        setLive({})
        location.hash = ''
        try {
          sessionStorage.removeItem(`draft:${id}`)
        } catch {}
      }
      if (current)
        setLive((old) =>
          Object.fromEntries(
            Object.entries(old).filter(([key]) => !current.messages.some((m) => m.id === key && m.completed))
          )
        )
    }
    setLoading(false)
    setRevision((n) => n + 1)
  }, [showArchive])
  useEffect(() => {
    api<{ authenticated: boolean }>('/auth')
      .then((result) => setAuthenticated(result.authenticated))
      .catch((e) => {
        setError(messageOf(e))
        setLoading(false)
      })
  }, [])
  useEffect(() => {
    if (!authenticated) return
    setLoading(true)
    void refresh().catch((e) => {
      setError(messageOf(e))
      setLoading(false)
    })
    void loadCatalog().catch((e) => setError(messageOf(e)))
  }, [authenticated, refresh, loadCatalog])
  useEffect(() => {
    if (!authenticated) return
    setDetail(null)
    setLive({})
    setError('')
    if (selected) {
      setLoading(true)
      void refresh().catch((e) => {
        setError(messageOf(e))
        setLoading(false)
      })
    }
  }, [selected, authenticated, refresh])
  useEffect(() => {
    if (!authenticated) return
    const events = new EventSource('/api/events')
    function schedule() {
      if (refreshTimer.current) return
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = undefined
        void refresh().catch((e) => setError(messageOf(e)))
      }, 80)
    }
    events.onopen = () => {
      setConnected(true)
      setLive({})
      schedule()
      void loadCatalog().catch((e) => setError(messageOf(e)))
    }
    events.onerror = () => setConnected(false)
    events.onmessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.type === 'delta' && data.bindingId === active.current) {
        setLive((old) => ({
          ...old,
          [data.messageId]:
            (old[data.messageId] ?? detailsRef.current?.messages.find((m) => m.id === data.messageId)?.text ?? '') +
            data.text,
        }))
      } else if (data.type === 'change' || data.type === 'connected') schedule()
      else if (data.type === 'error' && (!data.bindingId || data.bindingId === active.current)) setError(data.message)
    }
    return () => {
      events.close()
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = undefined
    }
  }, [authenticated, refresh, loadCatalog])
  function choose(id: string) {
    active.current = id
    setSelected(id)
    setView('chat')
    setSidebar(false)
    location.hash = id ? `session/${encodeURIComponent(id)}` : ''
  }
  useEffect(() => {
    function change() {
      const id = initialSelection()
      active.current = id
      setSelected(id)
      setView('chat')
    }
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        setNewDialog(true)
      }
      if (e.key === 'Escape') setSidebar(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  function conversationCreated(id: string) {
    setNewDialog(false)
    setShowArchive(false)
    choose(id)
    void refresh().catch((error) => setError(messageOf(error)))
  }

  const shown = sessions.filter(
    (s) =>
      (showArchive ? Boolean(s.archivedAt) : !s.archivedAt) &&
      `${s.address.title} ${s.adapterId} ${s.agent}`.toLowerCase().includes(search.toLowerCase())
  )
  const groups = [...new Set(shown.map((s) => s.address.guildId ?? (s.adapterId === 'web' ? 'web' : s.adapterId)))]
  return (
    <CakeProvider theme={palette} mode={mode} density="comfortable" className="app-root">
      {authenticated === false ? (
        <Login done={() => setAuthenticated(true)} />
      ) : (
        <div className="app-shell">
          {sidebar && (
            <button className="sidebar-backdrop" aria-label="收起会话列表" onClick={() => setSidebar(false)} />
          )}
          <aside className={`sidebar ${sidebar ? 'is-open' : ''}`} aria-label="会话导航">
            <div className="sidebar-heading">
              <button className="wordmark" onClick={() => choose('')} aria-label="Ineffa 首页">
                Ineffa
              </button>
              <IconButton
                className="mobile-only icon-button"
                icon="close"
                label="收起导航"
                onClick={() => setSidebar(false)}
              />
              <Badge className="desktop-only local-badge">本地</Badge>
            </div>
            <Button className="new-conversation" onClick={() => setNewDialog(true)}>
              <Icon name="plus" />
              新建会话
            </Button>
            <div className="search-field">
              <Icon name="search" />
              <TextBox
                className="form-control search-input"
                aria-label="搜索会话"
                placeholder="搜索会话"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="sidebar-label">
              <span>{showArchive ? '已归档' : '会话'}</span>
              <IconButton
                size="small"
                label={showArchive ? '返回活跃会话' : '查看归档'}
                icon={showArchive ? 'back' : 'archive'}
                onClick={() => setShowArchive(!showArchive)}
              />
            </div>
            <nav className="session-list" aria-label="会话列表">
              {groups.map((group) => (
                <section key={group}>
                  <h2 className="group-label">{group === 'web' ? '个人空间' : `KOOK · ${group}`}</h2>
                  {shown
                    .filter((s) => (s.address.guildId ?? (s.adapterId === 'web' ? 'web' : s.adapterId)) === group)
                    .map((s) => (
                      <ContextMenu
                        key={s.id}
                        className="session-context"
                        tabIndex={-1}
                        menuLabel={`${s.address.title}的会话菜单`}
                        menu={
                          <MenuItem danger onClick={() => setDeleteTarget(s)}>
                            <Icon name="trash" />
                            删除会话
                          </MenuItem>
                        }
                      >
                        <button
                          className={`session-item ${view === 'chat' && selected === s.id ? 'selected' : ''}`}
                          aria-current={view === 'chat' && selected === s.id ? 'page' : undefined}
                          onClick={() => choose(s.id)}
                        >
                          <Icon className="session-icon" name="chat" />
                          <span className="session-item-text">
                            <span className="session-item-title">{s.address.title}</span>
                            {s.adapterId !== 'web' && (
                              <small className="session-item-meta">
                                {s.adapterId} · {s.agent}
                              </small>
                            )}
                          </span>
                          {s.running && <span className="working-dot" aria-label="运行中" />}
                        </button>
                      </ContextMenu>
                    ))}
                </section>
              ))}
              {!shown.length && (
                <p className="sidebar-empty">{search ? '没有找到会话' : showArchive ? '暂无归档会话' : '暂无会话'}</p>
              )}
            </nav>
            <div className="sidebar-bottom">
              <Button
                variant="ghost"
                className={`settings-button ${view === 'settings' ? 'selected' : ''}`}
                onClick={() => {
                  setView('settings')
                  setSidebar(false)
                }}
              >
                <Icon name="settings" />
                连接与运行
                <Icon className="settings-chevron" name="chevron" />
              </Button>
              <div className="sidebar-status">
                <span className="sidebar-status-label">
                  <span className={`status-dot ${connected ? 'online' : ''}`} />
                  {connected ? '服务已连接' : authenticated === null ? '正在连接' : '正在重连'}
                </span>
              </div>
              <ThemeControl palette={palette} mode={mode} onPaletteChange={changePalette} onModeChange={changeMode} />
            </div>
          </aside>
          <main className="main-panel">
            <header className="main-header">
              <IconButton
                className="icon-button mobile-only"
                icon="menu"
                label="打开会话列表"
                onClick={() => setSidebar(true)}
              />
              <div className="header-breadcrumb">
                <span className="breadcrumb-scope">
                  {view === 'settings' ? '工作空间' : detail?.binding.address.guildId ? 'KOOK' : '个人空间'}
                </span>
                <Icon className="breadcrumb-divider" name="chevron" />
                <h1 className="breadcrumb-title">
                  {view === 'settings' ? '连接与运行' : (detail?.binding.address.title ?? '会话')}
                </h1>
              </div>
              <span className="grow" />
              {view === 'chat' && detail && (
                <>
                  <Badge className="header-agent">{detail.binding.agent}</Badge>
                  <IconButton label="会话设置" icon="more" onClick={() => setManage(true)} />
                </>
              )}
            </header>
            {error && (
              <div className="global-error">
                <Alert tone="danger">
                  <div className="section-title">
                    <span>{error}</span>
                    <div className="button-row">
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() => {
                          setError('')
                          if (authenticated === null)
                            void api<{ authenticated: boolean }>('/auth')
                              .then((d) => setAuthenticated(d.authenticated))
                              .catch((e) => setError(messageOf(e)))
                          else void refresh().catch((e) => setError(messageOf(e)))
                        }}
                      >
                        重试
                      </Button>
                      <IconButton icon="close" label="关闭错误提示" onClick={() => setError('')} />
                    </div>
                  </div>
                </Alert>
              </div>
            )}
            {view === 'settings' ? (
              <Settings catalog={catalog} reloadCatalog={loadCatalog} revision={revision} />
            ) : selected ? (
              detail ? (
                <Conversation key={selected} detail={detail} live={live} refresh={refresh} select={choose} />
              ) : (
                <Loading label={loading ? '正在载入会话' : '会话暂时无法载入'} />
              )
            ) : (
              <NewConversation
                inline
                catalog={catalog}
                close={() => setNewDialog(false)}
                created={conversationCreated}
              />
            )}
          </main>
          {newDialog && (
            <NewConversation catalog={catalog} close={() => setNewDialog(false)} created={conversationCreated} />
          )}
          {manage && detail && (
            <ManageConversation
              catalog={catalog}
              detail={detail}
              close={() => setManage(false)}
              changed={async (id) => {
                if (id !== undefined) {
                  setManage(false)
                  choose(id)
                }
                await refresh()
              }}
            />
          )}
          {deleteTarget && (
            <DeleteConversation
              conversation={deleteTarget}
              close={() => setDeleteTarget(null)}
              deleted={() => {
                const id = deleteTarget.id
                ++requestSeq.current
                setDeleteTarget(null)
                setSessions((old) => old.filter((s) => s.id !== id))
                if (active.current === id) {
                  setManage(false)
                  choose('')
                }
                try {
                  sessionStorage.removeItem(`draft:${id}`)
                } catch {}
                void refresh().catch((e) => setError(messageOf(e)))
              }}
            />
          )}
        </div>
      )}
    </CakeProvider>
  )
}
