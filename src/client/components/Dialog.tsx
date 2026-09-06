import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { DialogFeedback } from './Feedback';

export function Dialog({ title, subtitle, onClose, children, wide = false }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('input:not([type="checkbox"]), select, textarea')?.focus();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} aria-labelledby="dialog-title"
      onCancel={event => { event.preventDefault(); onClose(); }}>
      <div className="dialog-header">
        <div><p className="eyebrow">MODEL CONFIG MANAGER</p><h2 id="dialog-title">{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}</div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button>
      </div>
      <DialogFeedback />
      {children}
    </dialog>
  );
}
