// Shared tunables (motion v5, user-tuned 2026-09-08). One source for all presets.
export const ENTRY_S = 0.28;
export const EXIT_S = 0.24;
export const DRIFT_CARD = 0.04;
export const DRIFT_ART = 0.09;
export const SHUTTLE_X = 0.02;
export const SHUTTLE_ART_X = 0.015;
export const SHAKE_AMP = 3.5;
export const SHAKE_TILT = 0.08;
export const SHAKE_HZ = 0.5;
export const HOLD_ZOOM = 0.05;
export const WEIGHT_H = [0.8, 0.92, 1.0];
export const WEIGHT_W = [0.66, 0.78, 0.92];
export const GLOW_MAX = 0.55;
export const GLOW_CALM = 0.12;

// Fit (2026-09-27): cards use the frame. Panel aspect is clamped into these ranges,
// the art fills the card and the cropped part pans into view (see fit.ts).
export const SOLO_MIN_AR = 1.33;    // tall panels show as a 4:3 window that pans down the art
export const SOLO_MAX_AR = 2.0;     // wide strips become at most this wide
export const SOLO_BOX = [0.88, 0.94, 0.96];   // share of frame, by weight 1/2/3
export const DUO_MIN_AR = 0.75;
export const DUO_MAX_AR = 1.6;
export const DUO_BOX_H = 0.92;
export const DUO_GROUP_W = 0.96;
export const DUO_GAP = 24;
export const DUO_MAX_CROP = 0.55;   // each panel keeps >= 55% visible, else it goes solo
export const DUO_MIN_AREA = 0.45;   // a pair must cover >= 45% of the frame, else solo
export const PAN_SPAN = 0.7;        // how much of the cropped axis the pan travels

export const W = 1280;
export const H = 720;
