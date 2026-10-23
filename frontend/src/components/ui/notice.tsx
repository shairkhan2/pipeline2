import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, CircleAlert, CircleCheck, Copy, Info, RotateCw, TriangleAlert, X } from "lucide-react";

import { describeError, type ErrorInfo } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

export type NoticeTone = "info" | "success" | "warning" | "danger";

const TONE: Record<NoticeTone, { box: string; icon: typeof Info; iconClass: string }> = {
  info: { box: "bg-info-soft", icon: Info, iconClass: "text-info" },
  success: { box: "bg-success-soft", icon: CircleCheck, iconClass: "text-success" },
  warning: { box: "bg-warning-soft", icon: TriangleAlert, iconClass: "text-warning" },
  danger: { box: "bg-destructive-soft", icon: CircleAlert, iconClass: "text-destructive" },
};

/**
 * Compact message row: icon, short title, optional one-line reason, actions on
 * the right. Anything longer belongs in `details`, which stays collapsed.
 */
export function Notice({
  tone = "info",
  title,
  children,
  actions,
  details,
  onDismiss,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const t = TONE[tone];
  const Icon = t.icon;
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("rounded-2xl text-[14.5px] text-foreground", t.box, className)}>
      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <Icon className={cn("size-[18px] shrink-0", t.iconClass)} strokeWidth={1.75} aria-hidden />
        <div className="min-w-0 flex-1">
          {title ? <p className="font-medium leading-snug">{title}</p> : null}
          {children ? <div className={cn("leading-snug text-muted-foreground [overflow-wrap:anywhere]", title && "text-[13.5px]")}>{children}</div> : null}
        </div>
        {actions || details || onDismiss ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {actions}
            {details ? (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={detailsId}
                onClick={() => setOpen((value) => !value)}
                className="inline-flex min-h-11 items-center gap-1 rounded-full px-2.5 text-[13.5px] text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
              >
                Details
                <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
              </button>
            ) : null}
            {onDismiss ? (
              <Tooltip label="Dismiss" side="top"><button
                type="button"
                aria-label="Dismiss"
                onClick={onDismiss}
                className="grid size-11 place-items-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
              >
                <X className="size-4" aria-hidden />
              </button></Tooltip>
            ) : null}
          </div>
        ) : null}
      </div>
      {details ? (
        <div id={detailsId} hidden={!open} className="border-t border-foreground/8 px-4 py-3 text-[13px] text-muted-foreground">
          {details}
        </div>
      ) : null}
    </div>
  );
}

/** Small pill button used inside notices. */
export function NoticeButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-background px-3 text-[13.5px] font-medium text-foreground hover:bg-card disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function CopyId({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        });
      }}
      className="inline-flex min-h-11 items-center gap-1 rounded-full py-0.5 text-[12.5px] text-muted-foreground hover:text-foreground"
    >
      {done ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {done ? "Copied" : `Request ${id.slice(0, 8)}`}
    </button>
  );
}

/** Raw text for the Details panel: monospace, wraps, scrolls when long. */
export function RawDetails({ text, requestId }: { text?: string | null; requestId?: string | null }) {
  return (
    <div className="space-y-2">
      {text ? <pre className="max-h-48 overflow-auto font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</pre> : null}
      {requestId ? <CopyId id={requestId} /> : null}
    </div>
  );
}

/** An API error as one short line: title + Retry. Server text, hint and request ID sit under Details. */
export function ErrorNotice({
  error,
  info: given,
  onRetry,
  retrying = false,
  onDismiss,
  className,
}: {
  error?: unknown;
  info?: ErrorInfo;
  onRetry?: () => void;
  retrying?: boolean;
  onDismiss?: () => void;
  className?: string;
}) {
  const info = given ?? describeError(error);
  const tone: NoticeTone = info.kind === "rate-limit" || info.kind === "timeout" || info.kind === "network" ? "warning" : "danger";
  const showRetry = Boolean(onRetry) && info.retryable;
  // Server messages and recovery guidance stay behind Details.
  const hasDetails = Boolean(info.detail || info.requestId || info.hint);
  return (
    <Notice
      tone={tone}
      title={info.title}
      onDismiss={onDismiss}
      className={className}
      actions={
        showRetry ? (
          <NoticeButton onClick={onRetry!} disabled={retrying}>
            <RotateCw className={cn("size-3.5", retrying && "animate-spin")} aria-hidden />
            {retrying ? "Retrying" : "Retry"}
          </NoticeButton>
        ) : undefined
      }
      details={
        hasDetails ? (
          <div className="space-y-2">
            {info.hint ? <p>{info.hint}</p> : null}
            <RawDetails text={info.detail} requestId={info.requestId} />
          </div>
        ) : undefined
      }
    />
  );
}
