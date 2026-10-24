import { Tooltip } from "@/components/ui/tooltip";
import type { MoviePlanStyle } from "@/lib/movieApi";
import { cn } from "@/lib/utils";

const PILL = "inline-flex h-6 items-center rounded-full px-2.5 text-[12.5px] font-medium whitespace-nowrap";

/** Story-script style report summary: green when every metric is on target, amber with the misses otherwise. */
export function StyleReportBadge({ style }: { style?: MoviePlanStyle }) {
  if (!style) return <span className="text-xs text-muted-foreground">No report</span>;
  const text = `${style.onTarget}/${style.total}`;
  if (style.misses.length === 0) {
    return <span className={cn(PILL, "bg-success-soft text-success")} aria-label={`Style ${text}, all on target`}>{text}</span>;
  }
  const misses = `Off target: ${style.misses.join(", ")}`;
  return (
    <Tooltip label={misses} side="top">
      <button type="button" className={cn(PILL, "min-h-11 bg-transparent px-0")} aria-label={`Style ${text}. ${misses}`}>
        <span className={cn(PILL, "bg-warning-soft text-warning")}>{text}</span>
      </button>
    </Tooltip>
  );
}
