import { useEffect, useState } from 'react';

type ConcurrencySliderProps = {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
};

export function ConcurrencySlider({
  value,
  onChange,
  min = 1,
  max = 20,
  disabled = false,
}: ConcurrencySliderProps) {
  const [dragging, setDragging] = useState(false);
  const clamped = Math.min(max, Math.max(min, value));
  const percent = ((clamped - min) / (max - min)) * 100;

  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, [dragging]);

  return (
    <div
      className={`concurrency-slider${disabled ? ' concurrency-slider--disabled' : ''}${dragging ? ' concurrency-slider--dragging' : ''}`}
    >
      <span className="concurrency-slider__label">Concorrência</span>
      <div className="concurrency-slider__track-wrap">
        <span className="concurrency-slider__bound">{min}</span>
        <div className="concurrency-slider__track-container">
          <div className="concurrency-slider__track">
            <div
              className="concurrency-slider__fill"
              style={{ width: `${percent}%` }}
            />
          </div>
          <input
            type="range"
            className="concurrency-slider__input"
            min={min}
            max={max}
            step={1}
            value={clamped}
            disabled={disabled}
            onChange={(e) => onChange(+e.target.value)}
            onPointerDown={() => setDragging(true)}
          />
          <div
            className="concurrency-slider__thumb"
            style={{ left: `${percent}%` }}
          >
            <span className="concurrency-slider__value">{clamped}</span>
            <span className="concurrency-slider__thumb-dot" />
          </div>
        </div>
        <span className="concurrency-slider__bound">{max}</span>
      </div>
    </div>
  );
}
