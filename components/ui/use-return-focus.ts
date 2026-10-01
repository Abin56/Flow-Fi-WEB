"use client"

import * as React from "react"

/**
 * Radix returns focus on close only to a `<Dialog.Trigger>`; FlowFi opens nearly every dialog/sheet from
 * state (a row action, a menu item, a shortcut), so without this focus fell to <body> after Escape, Cancel
 * or Save. Records the element that had focus when the content opened (`onOpenAutoFocus` fires before Radix
 * moves focus inside) and restores it from `onCloseAutoFocus` if it's still in the document. Consumers'
 * own handlers run first; one that calls `event.preventDefault()` on close keeps full control.
 */
export function useReturnFocus(onOpenAutoFocus?: (event: Event) => void, onCloseAutoFocus?: (event: Event) => void) {
  const opener = React.useRef<HTMLElement | null>(null)

  return {
    onOpenAutoFocus: (event: Event) => {
      opener.current = document.activeElement as HTMLElement | null
      onOpenAutoFocus?.(event)
    },
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event)
      const target = opener.current
      opener.current = null
      if (event.defaultPrevented) return
      if (target && target !== document.body && target.isConnected) {
        event.preventDefault()
        target.focus({ preventScroll: true })
      }
    },
  }
}
