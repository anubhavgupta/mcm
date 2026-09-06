import { createContext, useContext } from 'react';
import { AlertCircle, Check, X } from 'lucide-react';

export interface Notice { message: string; error: boolean }
export const FeedbackContext = createContext<{ notice: Notice | null; dismiss: () => void } | null>(null);

export function DialogFeedback() {
  const feedback = useContext(FeedbackContext);
  if (!feedback?.notice) return null;
  const { notice, dismiss } = feedback;
  return <div className={`dialog-feedback ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>
    {notice.error ? <AlertCircle size={17} /> : <Check size={17} />}<span>{notice.message}</span>
    <button type="button" className="icon-button" onClick={dismiss} aria-label="Dismiss dialog notification"><X size={15} /></button>
  </div>;
}
