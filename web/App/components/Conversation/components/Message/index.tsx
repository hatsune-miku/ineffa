import { useEffect, useState } from 'react'

import { Accordion, AccordionItem, Alert, Badge } from '@a1knla/cakeui'

import { MarkdownContent } from './components/MarkdownContent'

import type { MessageView } from '../../../../../../src/view'
import { Icon } from '../../../../../components/Icon'
import { IconButton } from '../../../../../components/IconButton'
import { timeOf } from '../../../../../utils'

import './index.css'

export function Message({ message }: { message: MessageView }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  if (message.role === 'system') return <div className="system-message">{message.text}</div>
  return (
    <article className={`message message-${message.role}`}>
      <div className="message-header">
        <span className={`message-avatar ${message.role === 'assistant' ? 'agent-avatar' : ''}`}>
          {message.role === 'assistant' ? <Icon className="message-avatar-icon" name="terminal" /> : <span>你</span>}
        </span>
        <strong className="message-author">{message.author ?? (message.role === 'assistant' ? 'Agent' : '你')}</strong>
        <time className="message-time" dateTime={new Date(message.createdAt).toISOString()}>
          {timeOf(message.createdAt)}
        </time>
      </div>
      <div className="message-body">
        {message.text && (
          <div className="message-content">
            {message.role === 'assistant' ? (
              <MarkdownContent>{message.text}</MarkdownContent>
            ) : (
              <p className="user-text">{message.text}</p>
            )}
          </div>
        )}
        {message.files?.map(
          (file) =>
            (/^https?:\/\//.test(file.uri) || /^\/api\/attachments\/out_[a-f0-9]+\/\d+$/.test(file.uri)) && (
              <a
                className="attachment-link link"
                href={file.uri}
                key={file.uri}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="paperclip" />
                {file.name ?? '查看附件'}
              </a>
            )
        )}
        {!!message.tools?.length && (
          <Accordion className="tool-list">
            {message.tools.map((tool) => (
              <AccordionItem
                key={tool.id}
                title={
                  <span className="tool-title">
                    <Icon name="terminal" />
                    <span>{tool.name}</span>
                    <Badge>
                      {(
                        { completed: '完成', error: '失败', running: '运行中', pending: '等待' } as Record<
                          string,
                          string
                        >
                      )[tool.state] ?? tool.state}
                    </Badge>
                  </span>
                }
              >
                <div className="tool-detail">
                  {tool.input !== undefined && (
                    <pre className="preformatted tool-output">
                      {typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2)}
                    </pre>
                  )}
                  {tool.output && <pre className="preformatted tool-output">{tool.output}</pre>}
                </div>
              </AccordionItem>
            ))}
          </Accordion>
        )}
        {message.error && <Alert tone="danger">{message.error}</Alert>}
        {message.completed && message.role === 'assistant' && message.text && (
          <div className="message-actions">
            <IconButton
              className="message-copy-button"
              label={copied ? '已复制' : '复制回复'}
              icon={copied ? 'check' : 'copy'}
              onClick={() => {
                void navigator.clipboard
                  .writeText(message.text)
                  .then(() => {
                    setCopied(true)
                    setCopyError(false)
                  })
                  .catch(() => setCopyError(true))
              }}
            />
            {copyError && <span className="muted">无法访问剪贴板，请选择文本复制。</span>}
          </div>
        )}
      </div>
    </article>
  )
}
