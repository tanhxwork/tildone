import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  ReactNode,
} from "react";

/* ---------- Button ---------- */

type ButtonVariant = "default" | "primary" | "danger" | "ghost-danger" | "accent";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default: "border-edge bg-card hover:bg-hover",
  primary:
    "border-accent bg-accent text-accent-contrast hover:enabled:brightness-[1.08]",
  danger: "border-danger bg-danger text-white",
  "ghost-danger": "border-danger/40 text-danger hover:bg-danger/8",
  accent: "border-accent bg-card text-accent hover:bg-hover",
};

export function Button({
  variant = "default",
  small = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  small?: boolean;
}) {
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        small ? "px-2.5 py-1 text-[11.5px]" : "px-3 py-1.5"
      } ${BUTTON_VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

/* ---------- Tag chip ---------- */

export function TagChip({
  color,
  active = false,
  mini = false,
  as: Tag = "span",
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  color: string;
  active?: boolean;
  mini?: boolean;
  as?: "span" | "button";
}) {
  return (
    <Tag
      className={`group inline-flex items-center gap-1 rounded-full border text-[color-mix(in_srgb,var(--tag-color)_80%,var(--text))] transition-colors ${
        mini ? "cursor-default px-1.5 text-[10.5px]" : "cursor-pointer px-2 py-px text-[11.5px]"
      } ${
        active
          ? "border-(--tag-color) bg-(--tag-color)/22 font-semibold"
          : "border-(--tag-color)/45 bg-(--tag-color)/8 hover:bg-(--tag-color)/16"
      } ${className}`}
      style={{ "--tag-color": color } as CSSProperties}
      {...props}
    >
      {children}
    </Tag>
  );
}

/** Delete button inside a TagChip; revealed on chip hover (chip is a `group`). */
export function tagDeleteClass(visible = false): string {
  return `inline-flex items-center rounded-full p-px transition-[opacity,color] hover:text-danger focus-visible:opacity-100 ${
    visible
      ? "text-danger opacity-100"
      : "text-ink-faint opacity-0 group-hover:opacity-100"
  }`;
}

/* ---------- Segmented control ---------- */

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  full = false,
  "aria-label": ariaLabel,
}: {
  options: {
    value: T;
    label: ReactNode;
    title?: string;
    "aria-label"?: string;
  }[];
  value: T;
  onChange: (value: T) => void;
  full?: boolean;
  "aria-label"?: string;
}) {
  return (
    <div
      className={`${full ? "flex w-full" : "inline-flex"} overflow-hidden rounded-md border border-edge bg-card`}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <button
          key={option.value}
          title={option.title}
          aria-label={option["aria-label"]}
          className={`inline-flex items-center justify-center gap-[5px] px-2.5 py-[5px] transition-colors not-first:border-l not-first:border-edge ${
            full ? "flex-1 text-[12px]" : ""
          } ${
            option.value === value
              ? "bg-active font-semibold text-accent"
              : "text-ink-muted hover:bg-hover"
          }`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Shared class strings ---------- */

export const iconBtn =
  "inline-flex items-center justify-center rounded-md p-1 text-ink-muted transition-colors hover:bg-hover hover:text-ink";

export const field = "flex flex-col gap-[5px]";

export const fieldLabel =
  "text-[11px] font-semibold uppercase tracking-[0.4px] text-ink-faint";

export const inputBase =
  "w-full rounded-md border border-edge bg-card px-[9px] py-1.5 focus:border-accent focus:outline-none";

export const modalOverlay =
  "fixed inset-0 z-50 flex items-center justify-center bg-black/35";

export const modal =
  "flex flex-col gap-3.5 rounded-xl border border-edge bg-main p-4 shadow-pop";

export const modalTitle = "text-[15px] font-bold";
