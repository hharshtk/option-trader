"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A modal dialog on the native <dialog> element: the browser traps focus, closes it on Escape and
 * puts focus back where it was. Clicking the backdrop closes it too.
 */
export function Dialog({ open, onClose, title, className = "", children }: { open: boolean; onClose: () => void; title: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      // A click on the dialog element itself, outside its content box, is a click on the backdrop.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={`m-auto max-h-[min(88vh,52rem)] w-[min(100vw-1.5rem,56rem)] overflow-hidden rounded-sm border border-line-strong bg-panel p-0 text-fg shadow-2xl backdrop:bg-black/50 ${className}`}
    >
      {open && (
        <div className="flex max-h-[min(88vh,52rem)] flex-col">
          <header className="flex min-h-10 items-center gap-3 border-b border-line px-3 py-1.5">
            <h2 className="text-body font-semibold">{title}</h2>
            <button type="button" onClick={onClose} className="ml-auto inline-flex size-7 items-center justify-center rounded-sm text-muted hover:bg-raised hover:text-fg" aria-label="Close">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </div>
      )}
    </dialog>
  );
}
