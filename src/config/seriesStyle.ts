import { z } from 'zod';

export const seriesStyleSchema = z.object({
  writerMode: z.enum(['legacy', 'story']).optional(),
  matchMode: z.enum(['auto', 'caption', 'visual', 'semantic']).optional(),
  emotionTags: z.enum(['auto', 'on', 'off']).optional(),
  pacing: z.enum(['fast', 'normal', 'slow']).optional(),
  storyShape: z.enum(['movie', 'episode']).optional(),
}).strict();
export type SeriesStyle = z.infer<typeof seriesStyleSchema>;
export const ttsStyleSchema = z.object({
  voice_id: z.string().trim().min(1).max(300).optional(),
  speed: z.number().finite().min(0.5).max(2).optional(),
  style: z.string().max(2000).optional(),
  language: z.string().trim().min(1).max(100).optional(),
}).strict();

export const PACING = {
  fast: { SHOT_S: 2, RUN_S: 1, SHOT_MIN_S: 1.5, JAB_GAP: 5, MAX_RUN: 8 },
  normal: { SHOT_S: 2.5, RUN_S: 1.25, SHOT_MIN_S: 1.5, JAB_GAP: 4, MAX_RUN: 6 },
  slow: { SHOT_S: 3.25, RUN_S: 1.75, SHOT_MIN_S: 1.75, JAB_GAP: 3, MAX_RUN: 4 },
} as const;

export function resolveSeriesStyle(style: SeriesStyle = {}, env: NodeJS.ProcessEnv = process.env) {
  const pacing = style.pacing ?? env.PACING ?? 'normal';
  const emotionTags = style.emotionTags ?? env.EMOTION_TAGS ?? 'auto';
  return {
    writerMode: style.writerMode ?? env.WRITER_MODE ?? 'story',
    matchMode: style.matchMode ?? env.MATCH_MODE ?? 'auto',
    emotionTags,
    pacing: PACING[pacing as keyof typeof PACING] ?? PACING.normal,
    storyShape: (style.storyShape ?? env.STORY_SHAPE ?? 'movie') === 'episode' ? 'episode' as const : 'movie' as const,
  };
}

const option = (value: string, label: string, description: string) => ({ value, label, description });
export const STYLE_CATALOG = {
  writerMode: [option('legacy', 'Legacy', 'Step-based narration with continuity.'), option('story', 'Story', 'Story-first narration and source review.')],
  matchMode: [option('auto', 'Automatic', 'Use the current writer’s panel matching default.'), option('caption', 'Caption', 'Match narration against panel captions.'), option('visual', 'Visual', 'Select images using visual matching.'), option('semantic', 'Semantic', 'Match story meaning against available panels.')],
  emotionTags: [option('auto', 'Automatic', 'Enable emotion tags for expressive voice engines.'), option('on', 'On', 'Include emotion tags in narration.'), option('off', 'Off', 'Write narration without emotion tags.')],
  storyShape: [option('movie', 'Movie', 'One continuous narration across chapters for a merged long video.'), option('episode', 'Episode', 'Each chapter is a standalone short with its own cold open and hook.')],
  pacing: [option('fast', 'Fast', 'Shorter narration with quicker cuts and fewer jabs.'), option('normal', 'Normal', 'Keep the current narration length and cut timing.'), option('slow', 'Slow', 'Longer narration with slower cuts.')],
};

export function validationMessage(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || 'settings'}: ${issue.message}`).join('; ');
}
