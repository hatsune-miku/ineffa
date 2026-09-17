import Markdown, { type Components } from 'react-markdown'

import remarkGfm from 'remark-gfm'

import './index.css'

const elements: Components = {
  p: ({ children }) => <p className="markdown-paragraph">{children}</p>,
  h1: ({ children }) => <h1 className="markdown-heading-1">{children}</h1>,
  h2: ({ children }) => <h2 className="markdown-heading-2">{children}</h2>,
  h3: ({ children }) => <h3 className="markdown-heading-3">{children}</h3>,
  h4: ({ children }) => <h4 className="markdown-heading-4">{children}</h4>,
  h5: ({ children }) => <h5 className="markdown-heading-5">{children}</h5>,
  h6: ({ children }) => <h6 className="markdown-heading-6">{children}</h6>,
  ul: ({ children }) => <ul className="markdown-list">{children}</ul>,
  ol: ({ children, start }) => (
    <ol className="markdown-list" start={start}>
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="markdown-item">{children}</li>,
  em: ({ children }) => <em className="markdown-emphasis">{children}</em>,
  del: ({ children }) => <del className="markdown-deleted">{children}</del>,
  pre: ({ children }) => <pre className="preformatted markdown-pre">{children}</pre>,
  code: ({ children, className }) => <code className={`markdown-code ${className ?? ''}`}>{children}</code>,
  blockquote: ({ children }) => <blockquote className="markdown-quote">{children}</blockquote>,
  table: ({ children }) => <table className="markdown-table">{children}</table>,
  td: ({ children, style }) => (
    <td className="markdown-cell" style={style}>
      {children}
    </td>
  ),
  th: ({ children, style }) => (
    <th className="markdown-cell" style={style}>
      {children}
    </th>
  ),
  hr: () => <hr className="markdown-divider" />,
  a: ({ children, href }) => (
    <a className="link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <a className="link" href={src} target="_blank" rel="noopener noreferrer">
      {alt || '查看图片'}
    </a>
  ),
}

export function MarkdownContent({ children }: { children: string }) {
  return (
    <div className="markdown-content">
      <Markdown remarkPlugins={[remarkGfm]} components={elements}>
        {children}
      </Markdown>
    </div>
  )
}
