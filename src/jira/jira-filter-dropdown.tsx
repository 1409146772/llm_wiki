/**
 * A dependency-free multi-select dropdown for the Jira view's filter bar.
 *
 * The repo deliberately carries no popover/checkbox primitives (no radix,
 * no cmdk) — every selector so far is a native `<select>`. Filter options
 * here drive a server-side JQL re-query (see jira-view), so they need
 * multi-selection, which a toolbar-sized native listbox handles poorly.
 * This component fills that gap with a button + absolute-positioned
 * checkbox panel, styled to match the existing toolbar selects.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"

const TRIGGER_CLASS =
  "inline-flex h-8 items-center gap-1 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"

export interface JiraFilterDropdownProps {
  /** Accessible name of the control, e.g. "工单类型". */
  label: string
  /** Display names; also the emitted values (JQL uses display names). */
  options: string[]
  selected: string[]
  /** Trigger text when nothing is selected, e.g. "全部类型". */
  allLabel: string
  /** Formats the overflow badge, e.g. (n) => `+${n}`. */
  moreLabel: (extra: number) => string
  disabled?: boolean
  onChange: (next: string[]) => void
}

/** Trigger summary: none → allLabel, one → the name, many → first + "+N". */
export function summarizeSelection(
  selected: string[],
  allLabel: string,
  moreLabel: (extra: number) => string,
): string {
  if (selected.length === 0) return allLabel
  if (selected.length === 1) return selected[0]
  return `${selected[0]} ${moreLabel(selected.length - 1)}`
}

export function JiraFilterDropdown({
  label,
  options,
  selected,
  allLabel,
  moreLabel,
  disabled,
  onChange,
}: JiraFilterDropdownProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Dismiss on outside mousedown or Escape while the panel is open.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const sorted = useMemo(
    () => [...options].sort((a, b) => a.localeCompare(b, "zh")),
    [options],
  )

  const toggle = (name: string, checked: boolean) => {
    const set = new Set(selected)
    if (checked) set.add(name)
    else set.delete(name)
    // Emit in option order so the resulting JQL is stable (build idempotent).
    onChange(sorted.filter((o) => set.has(o)))
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className={TRIGGER_CLASS}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="max-w-36 truncate">
          {summarizeSelection(selected, allLabel, moreLabel)}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div
          role="group"
          aria-label={label}
          className="absolute left-0 top-full z-30 mt-1 max-h-64 w-56 overflow-y-auto rounded-md border border-input bg-popover text-popover-foreground shadow-md"
        >
          {sorted.map((name) => (
            <label
              key={name}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
            >
              <input
                type="checkbox"
                checked={selected.includes(name)}
                onChange={(e) => toggle(name, e.target.checked)}
              />
              <span className="truncate">{name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
