export type ShotBox = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type Shot = {
  panel: string;
  start_s: number;
  end_s: number;
  from?: 'left' | 'right';
  focus_y?: number;
  focusY?: number;
  focus_x?: number;
  box?: ShotBox;
  art_top?: number;
  art_bottom?: number;
  weight?: 1 | 2 | 3;
  pw?: number;
  ph?: number;
  // Render-only art crop; the original bubble-rich panel stays upstream.
  framed?: boolean;
  source_panel?: string;
  render_sources?: string[];
  crop?: number[];
  // Zero-based identity of the parsed narration line this shot came from,
  // including hold/expansion shots (not gold or non-hold indices).
  line_id?: number;
};
