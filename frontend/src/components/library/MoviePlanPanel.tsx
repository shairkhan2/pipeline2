import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

import { ErrorNotice } from "@/components/ui/notice";
import { describeError, type ErrorInfo } from "@/lib/errors";
import { getMoviePlan, type MovieExit, type MoviePlanView, type MovieRole } from "@/lib/movieApi";
import { cn } from "@/lib/utils";
import { StyleReportBadge } from "./StyleReportBadge";

const PILL = "inline-flex h-6 items-center rounded-full px-2.5 text-[12.5px] font-medium whitespace-nowrap";

const ROLE_LABEL: Record<MovieRole, string> = {
  opening: "Opening",
  setup: "Setup",
  rising: "Rising",
  climax: "Climax",
  payoff: "Payoff",
  aftermath: "Aftermath",
  filler: "Filler",
};

const EXIT_LABEL: Record<MovieExit, string> = { flow: "Flow", act_break: "Act break", finale: "Finale" };

function chapterLabel(ch: string): string {
  const n = Number(ch.replace(/^ch/, ""));
  return Number.isFinite(n) ? `Ch ${String(n).padStart(2, "0")}` : ch;
}

function seconds(n: number | undefined): string {
  return n === undefined ? "—" : `${Math.round(n)}s`;
}

/** Collapsible, read-only movie-mode plan. Renders nothing when the series has no plan. */
export function MoviePlanPanel({ slug }: { slug: string }) {
  const [plan, setPlan] = useState<MoviePlanView | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setPlan(null); setError(null); setOpen(false);
    getMoviePlan(slug, ctrl.signal)
      .then((value) => { if (!ctrl.signal.aborted) setPlan(value); })
      .catch((err) => { if (!ctrl.signal.aborted) setError(describeError(err)); });
    return () => ctrl.abort();
  }, [slug]);

  if (error) return <ErrorNotice info={error} />;
  if (!plan?.exists) return null;

  const regionId = `movie-plan-${slug}`;
  const planned = plan.chapters.reduce((sum, c) => sum + c.budget_s, 0);

  return (
    <section className="sr-group p-4 md:p-5" aria-label="Movie plan">
      <button
        type="button"
        className="flex min-h-11 w-full items-center justify-between gap-3 text-left"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(!open)}
      >
        <span>
          <span className="block text-sm font-medium">Movie plan</span>
          <span className="block text-xs text-muted-foreground">{plan.chapters.length} chapters · {seconds(planned)} planned</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open ? (
        <div id={regionId} className="mt-3 space-y-4">
          {plan.arc_summary ? (
            <div>
              <h4 className="text-[13px] font-medium text-muted-foreground">Story so far</h4>
              <p className="mt-1 text-sm leading-relaxed">{plan.arc_summary}</p>
            </div>
          ) : null}

          <div>
            <h4 className="text-[13px] font-medium text-muted-foreground">Open threads</h4>
            {plan.open_threads.length ? (
              <ul className="mt-1 flex flex-wrap gap-2">
                {plan.open_threads.map((thread) => <li key={thread} className={cn(PILL, "bg-muted text-foreground")}>{thread}</li>)}
              </ul>
            ) : <p className="mt-1 text-sm text-muted-foreground">None. Every thread is paid off.</p>}
          </div>

          <div className="overflow-x-auto" role="region" aria-label="Chapter plan" tabIndex={0}>
            <table className="w-full min-w-[640px] text-left text-sm">
              <caption className="sr-only">Planned role, length, entry, exit and style per chapter</caption>
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">Chapter</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Role</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Planned / actual</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Entry</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Exit</th>
                  <th scope="col" className="py-2 font-medium">Style</th>
                </tr>
              </thead>
              <tbody>
                {plan.chapters.map((c) => {
                  const over = c.durationS !== undefined && c.budget_s > 0 && Math.abs(c.durationS - c.budget_s) / c.budget_s > 0.25;
                  return (
                    <tr key={c.ch} className="border-t border-border align-top">
                      <th scope="row" className="py-2 pr-3 font-normal whitespace-nowrap">{chapterLabel(c.ch)}</th>
                      <td className="py-2 pr-3"><span className={cn(PILL, c.role === "climax" ? "bg-primary-soft text-primary-text" : "bg-muted text-foreground")}>{ROLE_LABEL[c.role]}</span></td>
                      <td className="py-2 pr-3 whitespace-nowrap tabular-nums">
                        {seconds(c.budget_s)} / <span className={cn(over && "text-warning")}>{c.rendered || c.durationS !== undefined ? seconds(c.durationS) : "not rendered"}</span>
                      </td>
                      <td className="max-w-[18rem] py-2 pr-3 text-muted-foreground" title={c.focus || undefined}>{c.entry || "—"}</td>
                      <td className="py-2 pr-3">
                        <span className={cn(PILL, c.exit === "finale" ? "bg-warning-soft text-warning" : c.exit === "act_break" ? "bg-info-soft text-info" : "bg-muted text-muted-foreground")}>{EXIT_LABEL[c.exit]}</span>
                      </td>
                      <td className="py-2"><StyleReportBadge style={c.style} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
