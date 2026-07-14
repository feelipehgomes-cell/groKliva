type SwitchToggleProps = {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label?: string;
  title?: string;
};

export function SwitchToggle({
  checked,
  onChange,
  disabled,
  label,
  title,
}: SwitchToggleProps) {
  return (
    <label className={`switch-toggle${disabled ? ' switch-toggle--disabled' : ''}`} title={title}>
      <input
        type="checkbox"
        className="switch-toggle__input"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="switch-toggle__track" aria-hidden />
      {label ? <span className="switch-toggle__label">{label}</span> : null}
    </label>
  );
}
