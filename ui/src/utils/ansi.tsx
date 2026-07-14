import type { ReactNode } from 'react';

const FG: Record<number, string> = {
  30: '#9ca3af',
  31: '#f87171',
  32: '#4ade80',
  33: '#facc15',
  34: '#60a5fa',
  35: '#c084fc',
  36: '#22d3ee',
  37: '#e5e7eb',
  90: '#6b7280',
  91: '#fca5a5',
  92: '#86efac',
  93: '#fde047',
  94: '#93c5fd',
  95: '#d8b4fe',
  96: '#67e8f9',
  97: '#f3f4f6',
};

const ANSI_RE = /\x1b\[([0-9;]*)m/g;

type Style = { color?: string; fontWeight?: number };

function applyCodes(codes: number[], style: Style): Style {
  const next = { ...style };
  for (const code of codes) {
    if (code === 0) return {};
    if (code === 1) next.fontWeight = 600;
    if (FG[code]) next.color = FG[code];
  }
  return next;
}

function styleKey(style: Style) {
  return `${style.color ?? ''}|${style.fontWeight ?? ''}`;
}

export function parseAnsi(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let style: Style = {};
  let key = 0;

  for (const match of text.matchAll(ANSI_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      const chunk = text.slice(lastIndex, index);
      const s = styleKey(style);
      nodes.push(
        s === '|' ? (
          chunk
        ) : (
          <span key={key++} style={style}>
            {chunk}
          </span>
        ),
      );
    }

    const codes = match[1]
      ? match[1].split(';').map((c) => parseInt(c, 10)).filter((n) => !Number.isNaN(n))
      : [0];
    style = applyCodes(codes, style);
    lastIndex = index + match[0].length;
  }

  const rest = text.slice(lastIndex);
  if (rest) {
    const s = styleKey(style);
    nodes.push(
      s === '|' ? (
        rest
      ) : (
        <span key={key++} style={style}>
          {rest}
        </span>
      ),
    );
  }

  return nodes.length ? nodes : [text];
}
