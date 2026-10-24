/** Read-only client for the movie-mode plan view (GET /api/series/<slug>/movie-plan). */
import { request } from "./api";

export type MovieRole = "opening" | "setup" | "rising" | "climax" | "payoff" | "aftermath" | "filler";
export type MovieExit = "flow" | "act_break" | "finale";

export interface MoviePlanStyle {
  onTarget: number;
  total: number;
  misses: string[];
}

export interface MoviePlanChapterView {
  ch: string;
  role: MovieRole;
  budget_s: number;
  entry: string;
  focus: string;
  exit: MovieExit;
  threads_open: string[];
  threads_paid: string[];
  rendered: boolean;
  durationS?: number;
  style?: MoviePlanStyle;
}

export interface MoviePlanView {
  exists: boolean;
  chapters: MoviePlanChapterView[];
  arc_summary: string;
  open_threads: string[];
}

export function getMoviePlan(slug: string, signal?: AbortSignal): Promise<MoviePlanView> {
  return request<MoviePlanView>(`/api/series/${encodeURIComponent(slug)}/movie-plan`, { signal });
}
