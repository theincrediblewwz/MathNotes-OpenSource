import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export function RoundedSelect({ label, options, value, disabled, onChange }: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    root.current?.querySelector<HTMLButtonElement>(`[aria-selected="true"]`)?.focus();
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const choose = (next: string) => { onChange(next); setOpen(false); trigger.current?.focus(); };
  return <div className="rounded-select" ref={root}>
    <button aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} disabled={disabled}
      ref={trigger} type="button" onClick={() => setOpen(!open)}
      onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
      <span>{options.find((option) => option.value === value)?.label ?? "选择笔记"}</span><ChevronDown aria-hidden="true" />
    </button>
    {open && !disabled ? <div className="rounded-select-menu" role="listbox" aria-label={label} id={id}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
        if (event.key === "Tab") setOpen(false);
        const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? []);
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === "ArrowDown" ? Math.min(buttons.length - 1, current + 1)
          : event.key === "ArrowUp" ? Math.max(0, current - 1)
          : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
        if (index >= 0) { event.preventDefault(); buttons[index]?.focus(); }
      }}>
      {options.map((option) => <button type="button" role="option" aria-selected={value === option.value} key={option.value}
        onClick={() => choose(option.value)}><span>{option.label}</span>{value === option.value ? <Check aria-hidden="true" /> : null}</button>)}
    </div> : null}
  </div>;
}
