import type { Ref } from 'react';

export function MethodSelect({ id, name, value, options, disabled, onChange, onBlur, inputRef, describedBy, invalid }: {
  id: string; name: string; value: string; options: string[]; disabled: boolean;
  onChange: (value: string) => void; onBlur: () => void; inputRef: Ref<HTMLInputElement>;
  describedBy: string; invalid: boolean;
}) {
  const selected = [...new Set(value.split(',').filter(item => item && item !== 'none'))];
  const choices = [...new Set([...options, ...selected])];
  const update = (next: string[]) => {
    const canonical = choices.filter(option => next.includes(option));
    onChange(canonical.length ? canonical.join(',') : 'none');
  };
  return <div id={id} className="method-select" role="region" aria-labelledby={`${id}-label`} aria-describedby={describedBy} aria-invalid={invalid}>
    <div className="method-choices">
      {choices.map((option, index) => <label className="checkbox-label" key={option}>
        <input type="checkbox" name={name} ref={index === 0 ? inputRef : undefined} checked={selected.includes(option)} disabled={disabled} onBlur={onBlur}
          aria-describedby={describedBy} onChange={event => update(event.target.checked ? [...selected, option] : selected.filter(item => item !== option))} />
        {option}
      </label>)}
    </div>
    <div className="method-summary"><strong>{selected.length ? `${selected.length} selected` : 'None selected'}</strong><button type="button" className="text-button" disabled={disabled || !selected.length} onBlur={onBlur} onClick={() => update([])}>Clear selection</button></div>
  </div>;
}
