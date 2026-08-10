import { useEffect, useState } from 'react';
import './toast.css';

/** A failure you can't miss.
 *
 *  Ratings save optimistically, which is right — the button should respond instantly. The danger
 *  is the other half: if the write then fails, an optimistic UI has already told you it worked.
 *  So a failure has to interrupt, and it has to say what to do about it. */
export interface ToastMessage {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  function push(text: string, kind: ToastMessage['kind'] = 'error') {
    // Date.now() would do, but two failures in the same millisecond would collide on key.
    setToasts((current) => [...current, { id: nextId++, text, kind }]);
  }

  function dismiss(id: number) {
    setToasts((current) => current.filter((t) => t.id !== id));
  }

  return { toasts, push, dismiss };
}

let nextId = 1;

export function Toasts({ toasts, dismiss }: { toasts: ToastMessage[]; dismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="rm-toasts">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} dismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  );
}

/** Errors stay until dismissed; anything else clears itself. A save that silently failed is the
 *  exact thing this exists to prevent, so it does not time out. */
const INFO_MS = 3000;

function Toast({ toast, dismiss }: { toast: ToastMessage; dismiss: () => void }) {
  useEffect(() => {
    if (toast.kind === 'error') return;
    const timer = setTimeout(dismiss, INFO_MS);
    return () => clearTimeout(timer);
    // `dismiss` is recreated every render; depending on it would restart the timer continuously
    // and the toast would never clear.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.kind]);

  return (
    <div className={`rm-toast rm-toast-${toast.kind}`} role="alert">
      <span>{toast.text}</span>
      <button className="rm-toast-close" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
