import { useRef, useState } from 'react';
import { Grip, X } from 'lucide-react';
import type { NativeInferenceDrag } from '../../shared/desktop';
import { errorMessage } from '../api';

export function InferenceWindowControls({ onError }: { onError: (message: string) => void }) {
  const [closing, setClosing] = useState(false);
  const dragging = useRef(false);
  const pending = useRef<NativeInferenceDrag | null>(null);
  const sending = useRef(false);
  const send = async () => {
    const move = window.bindings?.mcmDragInference;
    if (!move || sending.current) return;
    sending.current = true;
    try {
      while (pending.current) {
        const update = pending.current;
        pending.current = null;
        await move(update);
      }
    } catch (error) {
      dragging.current = false;
      pending.current = null;
      onError(`Unable to move inference window: ${errorMessage(error)}`);
    } finally { sending.current = false; }
  };
  const queue = (drag: NativeInferenceDrag) => { pending.current = drag; void send(); };
  const close = async () => {
    const closeWindow = window.bindings?.mcmCloseInference;
    if (!closeWindow) return;
    setClosing(true);
    try { await closeWindow(); }
    catch (error) { onError(`Unable to close inference window: ${errorMessage(error)}`); setClosing(false); }
  };
  return <div className="native-inference-controls">
    {window.bindings?.mcmDragInference && <button type="button" className="icon-button inference-drag-handle"
      aria-label="Move inference window" title="Drag to move; arrow keys move the window" disabled={closing}
      onPointerDown={event => {
        if (event.button !== 0 || sending.current) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        queue({ phase: 'start', screenX: event.screenX, screenY: event.screenY });
      }}
      onPointerMove={event => {
        if (dragging.current) queue({ phase: 'move', screenX: event.screenX, screenY: event.screenY });
      }}
      onPointerUp={event => {
        if (!dragging.current) return;
        dragging.current = false;
        queue({ phase: 'end', screenX: event.screenX, screenY: event.screenY });
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { dragging.current = false; pending.current = null; }}
      onLostPointerCapture={() => { dragging.current = false; }}
      onKeyDown={event => {
        const directions: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
        if (!Object.hasOwn(directions, event.key) || dragging.current || sending.current) return;
        event.preventDefault();
        const [screenX, screenY] = directions[event.key];
        queue({ phase: 'start', screenX: 0, screenY: 0 });
        queue({ phase: 'end', screenX, screenY });
      }}>
      <Grip size={15} />
    </button>}
    {window.bindings?.mcmCloseInference && <button type="button" className="icon-button" aria-label="Close inference window"
      title="Close inference window" disabled={closing} onClick={() => void close()}><X size={16} /></button>}
  </div>;
}
