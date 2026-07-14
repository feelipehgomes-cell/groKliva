import { useEffect, useRef } from 'react';
import { parseAnsi } from '../utils/ansi';

export type LogEntry = { line: string; stream: string };

type LogTerminalProps = {
  logs: LogEntry[];
  emptyMessage?: string;
  className?: string;
};

export function LogTerminal({
  logs,
  emptyMessage = 'Nenhum log ainda.',
  className = '',
}: LogTerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    if (!followRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div className={`terminal${className ? ` ${className}` : ''}`}>
      <div
        className="terminal__scroll"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {logs.length ? (
          logs.map((entry, i) => (
            <div key={i} className={`log-line log-line--${entry.stream}`}>
              {parseAnsi(entry.line)}
            </div>
          ))
        ) : (
          <p className="terminal__empty">{emptyMessage}</p>
        )}
      </div>
    </div>
  );
}
