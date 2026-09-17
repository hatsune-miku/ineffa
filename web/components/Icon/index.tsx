import type { SVGProps } from 'react'

const paths = {
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  plus: 'M12 5v14M5 12h14',
  search: 'm21 21-5-5M19 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5ZM7 9h9M7 13h6',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  stop: 'M6 6h12v12H6z',
  chevron: 'm9 5 7 7-7 7',
  down: 'm6 9 6 6 6-6',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3h6l.6 3 2.4 1 2.5-.6 2 5-2.2 1.7-.3 2.6 1.2 2.3-4.5 3-2-1.7-2.6.2L10 22l-5-2 .5-2.6L4 15l-3-.6v-5L4 9l1.2-2.3L4.7 4l4.3-1Z',
  link: 'm10 13 4-4M8 15l-2 2a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0m2 2 2-2a3.5 3.5 0 0 1 5 5l-5 5a3.5 3.5 0 0 1-5 0',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M6 18 18 6',
  copy: 'M8 8h12v13H8zM16 8V3H3v13h5',
  check: 'm5 12 4 4L19 6',
  info: 'M12 10v7M12 7v.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  folder: 'M3 6h6l2 2h10v12H3zM3 6V4h6l2 2h8v2',
  moon: 'M21 12.8A9 9 0 0 1 11.2 3 9 9 0 1 0 21 12.8Z',
  sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  back: 'm14 5-7 7 7 7',
  archive: 'M3 3h18v5H3zM5 8v13h14V8M9 12h6',
  retry: 'M3 10a9 9 0 1 1 2 9M3 3v7h7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  paperclip: 'm8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9M6 15l9-9',
  terminal: 'm4 6 6 6-6 6m9 0h7',
  pause: 'M8 5v14M16 5v14',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
} as const

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  )
}
