import './index.css'

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="small-empty">
      <p>{title}</p>
      {children}
    </div>
  )
}
