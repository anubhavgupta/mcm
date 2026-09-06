import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownLeft, PictureInPicture2 } from 'lucide-react';

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(options: { width: number; height: number }): Promise<Window>;
    };
  }
}

export function RuntimePictureInPicture({ children, notify }: {
  children: ReactNode; notify: (message: string, error?: boolean) => void;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [floating, setFloating] = useState(false);
  const [opening, setOpening] = useState(false);
  const pip = useRef<Window | null>(null);
  const mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pip.current?.close();
    };
  }, []);

  const restore = () => {
    pip.current?.close();
    pip.current = null;
    setTarget(null);
    setFloating(false);
    trigger.current?.focus();
  };

  const open = async () => {
    if (!window.documentPictureInPicture) {
      setFloating(true);
      notify('Native picture-in-picture is unavailable in this browser. Inference is floating inside MCM.');
      return;
    }
    setOpening(true);
    try {
      const child = await window.documentPictureInPicture.requestWindow({ width: 380, height: 300 });
      if (!mounted.current) { child.close(); return; }
      pip.current = child;
      child.addEventListener('pagehide', () => {
        if (pip.current !== child) return;
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
      setTarget(child.document.body);
    } catch (error) {
      pip.current?.close();
      pip.current = null;
      notify(`Unable to open picture-in-picture: ${error instanceof Error ? error.message : 'Browser request failed.'}`, true);
    } finally {
      if (mounted.current) setOpening(false);
    }
  };

  const detached = !!target || floating;
  const content = <div className="runtime-detached" onKeyDown={event => {
    if (event.key === 'Escape' && floating) { event.stopPropagation(); restore(); }
  }}>
    <div className="runtime-pip-toolbar"><strong>MCM Inference</strong><button className="button secondary" onClick={restore} aria-label="Return inference to page"><ArrowDownLeft size={14} />Return to page</button></div>
    {floating && <p className="field-help">Floating in this tab. Native picture-in-picture is not supported by this browser.</p>}
    {children}
  </div>;

  return <div className="runtime-container">
    <button ref={trigger} className="button secondary runtime-pip-trigger" disabled={opening}
      onClick={() => detached ? restore() : void open()} aria-label={detached ? 'Restore inference card' : 'Open inference picture-in-picture'}>
      <PictureInPicture2 size={16} />{opening ? 'Opening...' : detached ? 'Restore inference card' : 'Picture-in-picture'}
    </button>
    {!detached && children}
    {target && createPortal(content, target)}
    {floating && createPortal(<section className="runtime-floating" aria-label="Floating inference card">{content}</section>, document.body)}
  </div>;
}
