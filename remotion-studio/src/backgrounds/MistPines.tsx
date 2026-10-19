/* MistPines — code-drawn preset from the violet fog-forest reference.
 * Mood: deep violet sky, pale lavender glow at the horizon, receding hazy
 * ridges, a bright fog river through the middle, dark pine tiers, pale
 * broadleaf canopy in the foreground. Animated fog drift only (cheap).
 */
import React, {useMemo} from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {W, H} from './Starfield';

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MistPines: React.FC = () => {
  const frame = useCurrentFrame();
  const fogDx = Math.sin(frame * 0.008) * 26;
  const wispDx = Math.sin(frame * 0.005 + 2) * 16;

  const farPines = useMemo(() => {
    const rnd = mulberry(421);
    return Array.from({length: 40}, () => ({
      x: rnd() * W,
      y: H * 0.36 + rnd() * H * 0.2,
      s: 26 + rnd() * 50,
      o: 0.3 + rnd() * 0.35,
    }));
  }, []);

  const midPines = useMemo(() => {
    const rnd = mulberry(758);
    return Array.from({length: 44}, () => ({
      x: rnd() * W,
      y: H * 0.46 + rnd() * H * 0.24,
      s: 34 + rnd() * 66,
      o: 0.45 + rnd() * 0.4,
    }));
  }, []);

  const nearPines = useMemo(() => {
    const rnd = mulberry(902);
    return Array.from({length: 40}, () => ({
      x: rnd() * W,
      y: H * 0.52 + rnd() * H * 0.4,
      s: 40 + rnd() * 90,
      o: 0.6 + rnd() * 0.4,
    }));
  }, []);

  const canopy = useMemo(() => {
    const rnd = mulberry(613);
    return Array.from({length: 46}, () => ({
      x: rnd() * W,
      y: H * 0.72 + rnd() * H * 0.26,
      r: 20 + rnd() * 60,
      c: rnd() > 0.6 ? '150,170,235' : rnd() > 0.3 ? '110,125,205' : '60,80,150',
      o: 0.4 + rnd() * 0.5,
    }));
  }, []);

  const wisps = useMemo(() => {
    const rnd = mulberry(207);
    return Array.from({length: 10}, () => ({
      x: rnd() * W,
      y: H * 0.25 + rnd() * H * 0.5,
      w: 200 + rnd() * 380,
      h: 36 + rnd() * 80,
      o: 0.25 + rnd() * 0.4,
    }));
  }, []);

  return (
    <AbsoluteFill
      style={{
        background:
          'linear-gradient(180deg, #241b4d 0%, #4a3670 30%, #9a7fc0 46%, #d9b8e8 52%, #5a4a86 60%, #232047 78%, #0d0c22 100%)',
        overflow: 'hidden',
      }}
    >
      {/* horizon glow */}
      <div
        style={{
          position: 'absolute',
          left: '10%',
          top: '30%',
          width: '80%',
          height: '32%',
          background:
            'radial-gradient(ellipse 55% 50% at 55% 60%, rgba(240,214,250,0.95) 0%, rgba(200,160,230,0.5) 45%, transparent 72%)',
          filter: 'blur(8px)',
        }}
      />
      {/* receding ridges, far (pale) -> near (dark) */}
      <div
        style={{
          position: 'absolute',
          left: '-8%',
          top: '28%',
          width: '70%',
          height: '26%',
          background: 'linear-gradient(180deg, #8d7bb8 0%, #6a5a9c 100%)',
          clipPath: 'polygon(0% 45%, 25% 20%, 55% 40%, 80% 15%, 100% 35%, 100% 100%, 0% 100%)',
          opacity: 0.7,
          filter: 'blur(6px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: '-8%',
          top: '32%',
          width: '66%',
          height: '26%',
          background: 'linear-gradient(180deg, #54467f 0%, #3c3468 100%)',
          clipPath: 'polygon(0% 40%, 20% 15%, 50% 38%, 75% 18%, 100% 45%, 100% 100%, 0% 100%)',
          opacity: 0.8,
          filter: 'blur(5px)',
        }}
      />
      {/* fog river through the valley */}
      <div
        style={{
          position: 'absolute',
          left: `${-6 + fogDx * 0.4}%`,
          top: '44%',
          width: '82%',
          height: '17%',
          background:
            'linear-gradient(90deg, transparent, rgba(232,208,248,0.95) 30%, rgba(240,220,252,1) 55%, transparent)',
          filter: 'blur(10px)',
        }}
      />
      {/* far hazy pines */}
      {farPines.map((p, i) => (
        <div
          key={`f${i}`}
          style={{
            position: 'absolute',
            left: p.x,
            top: p.y,
            width: 0,
            height: 0,
            borderLeft: `${p.s * 0.32}px solid transparent`,
            borderRight: `${p.s * 0.32}px solid transparent`,
            borderBottom: `${p.s}px solid rgba(60,72,125,${p.o})`,
            filter: 'blur(3px)',
          }}
        />
      ))}
      {/* mid tier pines rising through the fog */}
      {midPines.map((p, i) => (
        <div
          key={`m${i}`}
          style={{
            position: 'absolute',
            left: p.x,
            top: p.y,
            width: 0,
            height: 0,
            borderLeft: `${p.s * 0.32}px solid transparent`,
            borderRight: `${p.s * 0.32}px solid transparent`,
            borderBottom: `${p.s}px solid rgba(25,38,72,${p.o})`,
            filter: 'blur(1px)',
          }}
        />
      ))}
      {/* low mist washing over midground */}
      <div
        style={{
          position: 'absolute',
          left: `${-10 + wispDx}%`,
          top: '58%',
          width: '120%',
          height: '16%',
          background:
            'linear-gradient(180deg, transparent, rgba(190,175,235,0.55) 50%, rgba(150,140,210,0.3) 80%, transparent)',
          filter: 'blur(16px)',
        }}
      />
      {/* drifting wisps */}
      {wisps.map((w, i) => (
        <div
          key={`w${i}`}
          style={{
            position: 'absolute',
            left: w.x + fogDx * (i % 2 === 0 ? 0.5 : -0.5),
            top: w.y,
            width: w.w,
            height: w.h,
            borderRadius: '50%',
            background: 'rgba(215,195,245,0.5)',
            opacity: w.o,
            filter: 'blur(20px)',
          }}
        />
      ))}
      {/* near dark pines */}
      {nearPines.map((p, i) => (
        <div
          key={`n${i}`}
          style={{
            position: 'absolute',
            left: p.x,
            top: p.y,
            width: 0,
            height: 0,
            borderLeft: `${p.s * 0.32}px solid transparent`,
            borderRight: `${p.s * 0.32}px solid transparent`,
            borderBottom: `${p.s}px solid rgba(8,18,32,${p.o})`,
          }}
        />
      ))}
      {/* pale foreground canopy */}
      {canopy.map((c, i) => (
        <div
          key={`c${i}`}
          style={{
            position: 'absolute',
            left: c.x,
            top: c.y,
            width: c.r * 2,
            height: c.r * 1.3,
            borderRadius: '50%',
            background: `radial-gradient(ellipse 50% 50% at 50% 55%, rgba(${c.c},${c.o}) 0%, rgba(${c.c},0.25) 55%, transparent 75%)`,
            filter: 'blur(5px)',
          }}
        />
      ))}
      {/* ground falloff */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '22%',
          background:
            'linear-gradient(180deg, transparent 0%, rgba(10,12,30,0.75) 55%, #05060f 100%)',
        }}
      />
      {/* vignette */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(ellipse 105% 90% at 50% 45%, transparent 55%, rgba(5,3,18,0.6) 100%)',
        }}
      />
      <div style={{position: 'absolute', top: 0, left: 0, right: 0, height: 10, background: '#000'}} />
      <div style={{position: 'absolute', bottom: 0, left: 0, right: 0, height: 10, background: '#000'}} />
    </AbsoluteFill>
  );
};
