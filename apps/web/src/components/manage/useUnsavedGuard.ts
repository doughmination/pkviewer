"use client";

import { useEffect } from "react";

/**
 * Warns before leaving a page with unsaved edits.
 *
 * Deliberately minimal: a `beforeunload` listener, which the browser turns into
 * its own confirmation. Intercepting in-app navigation would mean owning a
 * router-level state machine, which is far more machinery than this earns — the
 * save bar already states plainly when there are unsaved changes.
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Required by some browsers for the prompt to appear at all.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}
