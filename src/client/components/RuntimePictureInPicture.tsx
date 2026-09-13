import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ArrowDownLeft, PictureInPicture2 } from 'lucide-react';
import { mirrorTheme } from '../theme';
import { currentTheme, desktopInference } from '../desktop';

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(options: { width: number; height: number; preferInitialWindowPlacement?: boolean }): Promise<Window>;
    };
  }
}

export function RuntimePictureInPicture({ children, notify }: {
  children: (control: ReactNode) => ReactNode; notify: (message: string, error?: boolean) => void;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [floating, setFloating] = useState(false);
  const [opening, setOpening] = useState(false);
  const [nativeOpen, setNativeOpen] = useState(false);
  const pip = useRef<Window | null>(null);
  const stopMirroring = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const inlineContent = useRef<HTMLDivElement>(null);
  const nativeUnavailable = useRef(false);
  const nativeRevision = useRef(0);

  useEffect(() => {
    const bridge = desktopInference();
    if (!bridge) return;
    let active = true;
    const revision = nativeRevision.current;
    void bridge.mcmInferenceState().then(state => {
      if (active && revision === nativeRevision.current) setNativeOpen(state.open);
    }).catch(error => { if (active) notify(`Unable to read native inference window state: ${error instanceof Error ? error.message : String(error)}`, true); });
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.open !== 'boolean') return;
      nativeRevision.current++;
      setNativeOpen(event.detail.open);
    };
    const publishTheme = () => {
      void bridge.mcmSetInferenceTheme(currentTheme()).catch(error => {
        if (active) notify(`Unable to synchronize the native inference theme: ${error instanceof Error ? error.message : String(error)}`, true);
      });
    };
    window.addEventListener('mcm-inference-state', receive);
    const receiveError = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail?.message === 'string') notify(event.detail.message, true);
    };
    window.addEventListener('mcm-inference-error', receiveError);
    const observer = new MutationObserver(publishTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    publishTheme();
    return () => {
      active = false; observer.disconnect();
      window.removeEventListener('mcm-inference-state', receive);
      window.removeEventListener('mcm-inference-error', receiveError);
    };
  }, [notify]);

  const openFloating = () => {
    setFloating(true);
    notify('Native picture-in-picture is unavailable in this browser or WebView. Inference is floating inside MCM.');
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopMirroring.current?.();
      pip.current?.close();
    };
  }, []);

  const restore = async () => {
    const bridge = desktopInference();
    if (nativeOpen && bridge) {
      nativeRevision.current++;
      setOpening(true);
      try {
        const state = await bridge.mcmCloseInference();
        if (mounted.current) setNativeOpen(state.open);
      } catch (error) {
        notify(`Unable to close the native inference window: ${error instanceof Error ? error.message : String(error)}`, true);
      } finally { if (mounted.current) setOpening(false); }
      return;
    }
    stopMirroring.current?.();
    stopMirroring.current = null;
    pip.current?.close();
    pip.current = null;
    setTarget(null);
    setFloating(false);
    trigger.current?.focus();
  };

  const open = async () => {
    const bridge = desktopInference();
    if (!bridge && (!window.documentPictureInPicture || nativeUnavailable.current)) {
      openFloating();
      return;
    }
    setOpening(true);
    try {
      if (!inlineContent.current) throw new Error('Inference card is not ready.');
      // Measure the compact layout synchronously so opening retains the user's activation.
      const measure = document.createElement('div');
      measure.className = 'runtime-pip-document runtime-pip-measure';
      measure.setAttribute('aria-hidden', 'true');
      measure.inert = true;
      const snapshot = document.createElement('div');
      snapshot.className = 'runtime-detached';
      snapshot.append(inlineContent.current.cloneNode(true));
      snapshot.querySelector('.runtime-pip-trigger')?.remove();
      measure.append(snapshot);
      document.body.append(measure);
      let height: number;
      try {
        // The request counters appear only after inference starts.
        const requestRowBuffer = snapshot.querySelector('.token-counts') ? 0 : 32;
        height = Math.ceil(snapshot.getBoundingClientRect().height) + requestRowBuffer;
      }
      finally { measure.remove(); }
      if (bridge) {
        nativeRevision.current++;
        const state = await bridge.mcmOpenInference({ width: 280, height: height + 40, theme: currentTheme() });
        if (!state.open) throw new Error('The native inference window could not be opened.');
        if (mounted.current) setNativeOpen(state.open);
        return;
      }
      if (!window.documentPictureInPicture) throw new Error('Picture-in-picture is unavailable.');
      const child = await window.documentPictureInPicture.requestWindow({ width: 280, height, preferInitialWindowPlacement: true });
      if (!mounted.current) { child.close(); return; }
      pip.current = child;
      child.addEventListener('pagehide', () => {
        if (pip.current !== child) return;
        stopMirroring.current?.();
        stopMirroring.current = null;
        pip.current = null;
        if (mounted.current) { setTarget(null); trigger.current?.focus(); }
      }, { once: true });
      child.document.title = 'MCM Inference';
      document.querySelectorAll('link[rel="stylesheet"], style').forEach(node => {
        const copy = node.cloneNode(true);
        if (node instanceof HTMLLinkElement && copy instanceof HTMLLinkElement) copy.href = node.href;
        child.document.head.appendChild(copy);
      });
      child.document.body.className = 'runtime-pip-document';
      stopMirroring.current = mirrorTheme(child.document);
      setTarget(child.document.body);
    } catch (error) {
      stopMirroring.current?.();
      stopMirroring.current = null;
      pip.current?.close();
      pip.current = null;
      if (!mounted.current) return;
      setTarget(null);
      const message = error instanceof Error ? error.message : 'Browser request failed.';
      if (!bridge && error instanceof Error && (error.name === 'NotSupportedError' || /internal error:\s*no window/i.test(message))) {
        nativeUnavailable.current = true;
        openFloating();
      } else notify(`Unable to open picture-in-picture: ${message}`, true);
    } finally {
      if (mounted.current) setOpening(false);
    }
  };

  const detached = !!target || floating || nativeOpen;
  const content = <div className="runtime-detached" onKeyDown={event => {
    if (event.key === 'Escape' && floating) { event.stopPropagation(); void restore(); }
  }}>
    {floating && <div className="runtime-pip-toolbar"><strong>MCM Inference</strong><button className="button secondary" onClick={() => void restore()} aria-label="Return inference to page"><ArrowDownLeft size={14} />Return to page</button></div>}
    {floating && <p className="field-help">Floating inside MCM. Native picture-in-picture is unavailable in this browser or WebView.</p>}
    {children(null)}
  </div>;

  const label = detached ? 'Restore inference card' : 'Open inference picture-in-picture';
  const control = <button ref={trigger} type="button" className="icon-button runtime-pip-trigger" disabled={opening}
    onClick={() => detached ? void restore() : void open()} aria-label={label} title={label}>
    <PictureInPicture2 size={16} />
  </button>;
  return <div className="runtime-container">
    {detached ? <section className="runtime-card"><div className="runtime-heading"><h2><Activity size={16} />Inference</h2>{control}</div></section>
      : <div ref={inlineContent}>{children(control)}</div>}
    {target && createPortal(content, target)}
    {floating && createPortal(<section className="runtime-floating" aria-label="Floating inference card">{content}</section>, document.body)}
  </div>;
}
