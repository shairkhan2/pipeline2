import { useEffect, useMemo, useState } from "react";

import { SeriesSettingsFields, useSeriesSettingsDraft } from "@/components/library/SeriesSettingsEditor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/ui/notice";
import { api, type JobRecord, type JobRunSettingsPatch, type RenderNode, type RenderQuality } from "@/lib/api";
import { describeError, type ErrorInfo } from "@/lib/errors";
import { buildIntakeLanes, DEFAULT_LANE_ID, LANE_ID_RE } from "@/lib/renderLanes";
import {
  ChaptersField,
  normalizeChapters,
  outroDraftFrom,
  OutroFields,
  RenderLaneField,
  RenderQualityField,
  type OutroDraft,
} from "./RunOptionFields";

interface RunDraft {
  chapters: string;
  renderLane: string;
  renderQuality: RenderQuality;
  outro: OutroDraft;
}

function runDraftFrom(job: JobRecord | null): RunDraft {
  const lane = String(job?.renderLane ?? "").trim().toLowerCase();
  return {
    chapters: typeof job?.chapters === "string" && job.chapters.trim() ? job.chapters.trim() : "all",
    renderLane: LANE_ID_RE.test(lane) ? lane : DEFAULT_LANE_ID,
    renderQuality: job?.renderQuality === "720p" ? "720p" : "1080p",
    outro: outroDraftFrom(job?.outroConfig),
  };
}

function outroPayload(draft: OutroDraft): NonNullable<JobRunSettingsPatch["outroConfig"]> {
  return draft.enabled
    ? {
        enabled: true,
        totalChapters: Math.max(1, draft.totalChapters),
        coveredChapters: Math.max(1, draft.coveredChapters),
        hookType: draft.hookType,
        customPrompt: draft.customPrompt.trim() || undefined,
      }
    : { enabled: false };
}

/** "Change settings" for a paused (or queued, failed, interrupted) run: Series settings plus this run's options. */
export function RunSettingsDialog({ job, open, onClose, onSaved, privileged }: {
  job: JobRecord | null;
  open: boolean;
  onClose: () => void;
  onSaved?: (job: JobRecord | null, resumed: boolean) => void;
  privileged: boolean;
}) {
  const slug = typeof job?.slug === "string" ? job.slug : "";
  const draft = useSeriesSettingsDraft(slug, open);
  const [nodes, setNodes] = useState<RenderNode[]>([]);
  const [run, setRun] = useState<RunDraft>(() => runDraftFrom(job));
  const [initialRun, setInitialRun] = useState<RunDraft>(() => runDraftFrom(job));
  const [chaptersError, setChaptersError] = useState("");
  const [laneError, setLaneError] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "resume">("");
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [status, setStatus] = useState("");
  const jobId = job?.id ?? "";

  useEffect(() => {
    if (!open) return;
    const next = runDraftFrom(job);
    setRun(next);
    setInitialRun(next);
    setChaptersError("");
    setLaneError("");
    setError(null);
    setStatus("");
    let active = true;
    api.studio.nodes().then((res) => { if (active) setNodes(res.nodes || []); }).catch(() => undefined);
    return () => { active = false; };
    // Reset only when the dialog opens or targets another job, not on every job poll.
  }, [open, jobId]);

  const lanes = useMemo(() => buildIntakeLanes(draft.catalog, nodes, initialRun.renderLane, run.renderLane), [draft.catalog, nodes, initialRun.renderLane, run.renderLane]);
  const editable = job?.settingsEditable !== false;
  const off = !privileged || Boolean(busy) || !editable;
  const canResume = Array.isArray(job?.controlActions) ? job!.controlActions.includes("resume") : job?.status === "paused";

  function runPatch(): { patch: JobRunSettingsPatch } | { invalid: string } {
    const patch: JobRunSettingsPatch = {};
    const check = normalizeChapters(run.chapters);
    if (!check.ok) {
      setChaptersError(check.error);
      return { invalid: check.error };
    }
    if (check.spec !== initialRun.chapters.trim().toLowerCase()) patch.chapters = check.spec;
    if (run.renderLane !== initialRun.renderLane) {
      const lane = lanes.find((item) => item.id === run.renderLane);
      if (!lane || !lane.available) {
        const message = lane ? `${lane.label} is unavailable: ${lane.unavailableReason || "not available"}.` : "Choose a render lane from the list.";
        setLaneError(message);
        return { invalid: message };
      }
      patch.renderLane = lane.id;
    }
    if (run.renderQuality !== initialRun.renderQuality) patch.renderQuality = run.renderQuality;
    if (JSON.stringify(outroPayload(run.outro)) !== JSON.stringify(outroPayload(initialRun.outro))) patch.outroConfig = outroPayload(run.outro);
    return { patch };
  }

  async function submit(resume: boolean) {
    if (!job || !jobId || busy || !privileged) return;
    setError(null);
    setStatus("");
    const built = runPatch();
    if ("invalid" in built) {
      setStatus("Check the highlighted fields.");
      return;
    }
    const series = draft.settings && draft.dirty ? draft.buildPatch() : null;
    if (series && "invalid" in series) {
      setError(describeError(new Error(series.invalid)));
      setStatus(series.invalid);
      return;
    }
    setBusy(resume ? "resume" : "save");
    let latest: JobRecord | null = null;
    try {
      if (series) {
        setStatus("Saving series settings…");
        await draft.save();
      }
      if (Object.keys(built.patch).length) {
        setStatus("Saving run settings…");
        latest = await api.intake.updateJobSettings(jobId, built.patch);
        const next = runDraftFrom(latest);
        setRun(next);
        setInitialRun(next);
      }
      if (resume) {
        setStatus("Resuming…");
        const res = await api.intake.resumeJob(jobId);
        latest = res.job ?? latest;
      }
      setStatus(resume ? "Saved. The run is resuming." : "Settings saved.");
      onSaved?.(latest, resume);
      if (resume) onClose();
    } catch (err) {
      setError(describeError(err));
      setStatus("Saving failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto [&_[data-slot=dialog-close]]:size-11 [&_[role=alert]_button]:min-h-11 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Change settings</DialogTitle>
          <DialogDescription>{job?.title || job?.slug || job?.id || "This run"}</DialogDescription>
        </DialogHeader>
        {!editable ? <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning" role="status">Pause the run first.</p> : null}

        <section aria-labelledby="runSettingsSeries" className="space-y-4">
          <div>
            <h3 id="runSettingsSeries" className="text-[17px] font-semibold">Series</h3>
            <p className="text-xs text-muted-foreground">Saved to the series. Applies to chapters that are not rendered yet.</p>
          </div>
          {!slug ? <p className="text-sm text-muted-foreground" role="status">This run has no series yet.</p> : null}
          {slug && draft.error ? <ErrorNotice info={draft.error} /> : null}
          {slug && !draft.settings && !draft.error ? <p className="text-sm text-muted-foreground" role="status">Loading settings…</p> : null}
          {draft.settings ? <SeriesSettingsFields draft={draft} privileged={privileged} disabled={off} idPrefix={`runCardAnim-${jobId}`} /> : null}
        </section>

        <section aria-labelledby="runSettingsRun" className="mt-2">
          <h3 id="runSettingsRun" className="text-[17px] font-semibold">This run</h3>
          <p className="text-xs text-muted-foreground">Saved to this job. Finished chapters are skipped.</p>
          <fieldset disabled={off} className="min-w-0 border-0 p-0">
            <ChaptersField
              id={`runChapters-${jobId}`}
              errorId={`runChaptersError-${jobId}`}
              value={run.chapters}
              error={chaptersError}
              onChange={(value) => { setRun({ ...run, chapters: value }); setChaptersError(""); }}
            />
            <RenderLaneField
              id={`runLane-${jobId}`}
              noteId={`runLaneNote-${jobId}`}
              errorId={`runLaneError-${jobId}`}
              lanes={lanes}
              value={run.renderLane}
              error={laneError}
              onChange={(value) => { setRun({ ...run, renderLane: value }); setLaneError(""); }}
            />
            <RenderQualityField value={run.renderQuality} onChange={(value) => setRun({ ...run, renderQuality: value })} />
            <OutroFields value={run.outro} onChange={(outro) => setRun({ ...run, outro })} />
          </fieldset>
        </section>

        {error ? <ErrorNotice info={error} /> : null}
        <p className="min-h-5 text-sm text-muted-foreground" role="status" aria-live="polite">{status}</p>

        <DialogFooter>
          <Button type="button" variant="ghost" className="min-h-11" disabled={Boolean(busy)} onClick={onClose}>Cancel</Button>
          <Button type="button" variant="outline" className="min-h-11" disabled={off} onClick={() => void submit(false)}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          {canResume ? (
            <Button type="button" className="min-h-11" disabled={off} onClick={() => void submit(true)}>
              {busy === "resume" ? "Saving…" : "Save and resume"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
