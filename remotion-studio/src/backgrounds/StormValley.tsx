/* StormValley — code-drawn preset from the storm-mountain reference.
 * Mood: black storm clouds, pale break of light left-center, far peak in mist,
 * dark valley + lake, black pines, ember-red foliage bottom-right over rock.
 * 1280x720 landscape adaptation. Animated mist only (cheap, deterministic).
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

export const StormValley: React.FC = () => {
  const frame = useCurrentFrame();
  const mistDx = Math.sin(frame * 0.008) * 22;
  const cloudDx = Math.sin(frame * 0.005 + 1) * 12;

  const clouds = useMemo(() => {
    const rnd = mulberry(77);
    return Array.from({length: 16}, (_, i) => ({
      x: rnd() * W,
      y: rnd() * H * 0.42,
      w: 180 + rnd() * 420,
      h: 50 + rnd() * 110,
      // pale break lives left-center; clouds around it are lighter there
      light: i % 4 === 0,
      o: 0.35 + rnd() * 0.5,
    }));
  }, []);

  const pines = useMemo(() => {
    const rnd = mulberry(913);
    return Array.from({length: 46}, () => ({
      x: rnd() * W,
      y: H * 0.58 + rnd() * H * 0.12,
      s: 18 + rnd() * 42,
      o: 0.7 + rnd() * 0.3,
    }));
  }, []);

  const embers = useMemo(() => {
    const rnd = mulberry(155);
    // bias to bottom-right diagonal like the reference
    return Array.from({length: 70}, () => {
      const t = rnd();
      return {
        x: W * 0.25 + t * W * 0.75 + (rnd() - 0.5) * 120,
        y: H * 0.62 + rnd() * H * 0.36 - t * H * 0.08,
        r: 14 + rnd() * 46,
        c: rnd() > 0.5 ? '255,42,18' : rnd() > 0.25 ? '255,96,20' : '140,10,10',
        o: 0.35 + rnd() * 0.55,
      };
    });
  }, []);

  const sparks = useMemo(() => {
    const rnd = mulberry(311);
    return Array.from({length: 130}, () => ({
      x: W * 0.2 + rnd() * W * 0.8,
      y: H * 0.6 + rnd() * H * 0.38,
      r: 1 + rnd() * 3.2,
      o: 0.3 + rnd() * 0.7,
    }));
  }, []);

  return (
    <AbsoluteFill
      style={{
        background:
          'linear-gradient(180deg, #030509 0%, #080d17 28%, #232f42 46%, #9aa3b2 50%, #3a4354 55%, #141b26 66%, #070a11 100%)',
        overflow: 'hidden',
      }}
    >
      {/* pale break of light, left-center */}
      <div
        style={{
          position: 'absolute',
          left: '8%',
          top: '6%',
          width: '52%',
          height: '58%',
          background:
            'radial-gradient(ellipse 45% 42% at 42% 52%, rgba(238,242,248,0.95) 0%, rgba(205,213,228,0.55) 32%, rgba(120,130,148,0.18) 55%, transparent 72%)',
          filter: 'blur(6px)',
        }}
      />
      {/* storm clouds */}
      {clouds.map((c, i) => (
        <div
          key={`c${i}`}
          style={{
            position: 'absolute',
            left: c.x + cloudDx * (i % 3 === 0 ? 1 : -0.6),
            top: c.y,
            width: c.w,
            height: c.h,
            borderRadius: '50%',
            background: c.light
              ? 'rgba(190,200,214,0.5)'
              : 'rgba(5,8,14,0.85)',
            opacity: c.o,
            filter: 'blur(26px)',
          }}
        />
      ))}

      {/* far peak, center */}
      <div
        style={{
          position: 'absolute',
          left: '34%',
          top: '30%',
          width: '36%',
          height: '32%',
          background: 'linear-gradient(180deg, #4a5468 0%, #232b3a 45%, #121722 100%)',
          clipPath: 'polygon(50% 0%, 72% 34%, 100% 100%, 0% 100%, 30% 38%)',
          opacity: 0.95,
        }}
      />
      {/* left + right ridges */}
      <div
        style={{
          position: 'absolute',
          left: '-6%',
          top: '34%',
          width: '44%',
          height: '38%',
          background: 'linear-gradient(180deg, #10141c 0%, #1c1410 60%, #2b1c10 100%)',
          clipPath: 'polygon(0% 18%, 22% 0%, 45% 30%, 68% 48%, 100% 100%, 0% 100%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: '-6%',
          top: '36%',
          width: '46%',
          height: '38%',
          background: 'linear-gradient(180deg, #0d1119 0%, #241a10 55%, #3a2412 100%)',
          clipPath: 'polygon(100% 22%, 76% 2%, 52% 32%, 28% 52%, 0% 100%, 100% 100%)',
        }}
      />
      {/* mist hugging the peak */}
      <div
        style={{
          position: 'absolute',
          left: `${28 + mistDx * 0.3}%`,
          top: '46%',
          width: '44%',
          height: '9%',
          background:
            'linear-gradient(90deg, transparent, rgba(220,228,240,0.75) 30%, rgba(220,228,240,0.85) 60%, transparent)',
          filter: 'blur(10px)',
          opacity: 0.8,
        }}
      />
      {/* valley fog bed */}
      <div
        style={{
          position: 'absolute',
          left: `${-4 + mistDx * 0.4}%`,
          top: '57%',
          width: '70%',
          height: '10%',
          background:
            'linear-gradient(90deg, transparent, rgba(200,210,224,0.5) 40%, rgba(200,210,224,0.25) 70%, transparent)',
          filter: 'blur(14px)',
        }}
      />
      {/* lake glint */}
      <div
        style={{
          position: 'absolute',
          left: '30%',
          top: '64.5%',
          width: '16%',
          height: '5%',
          background:
            'radial-gradient(ellipse 50% 50% at 50% 50%, rgba(210,222,238,0.9) 0%, rgba(120,135,155,0.35) 60%, transparent 75%)',
          filter: 'blur(1px)',
          transform: 'skewX(-18deg)',
          opacity: 0.85,
        }}
      />
      {/* dark forest band */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: '60%',
          height: '20%',
          background: 'linear-gradient(180deg, rgba(10,14,10,0.2) 0%, #0b0e0c 45%, #060807 100%)',
        }}
      />
      {pines.map((p, i) => (
        <div
          key={`p${i}`}
          style={{
            position: 'absolute',
            left: p.x,
            top: p.y,
            width: 0,
            height: 0,
            borderLeft: `${p.s * 0.32}px solid transparent`,
            borderRight: `${p.s * 0.32}px solid transparent`,
            borderBottom: `${p.s}px solid rgba(8,12,10,${p.o})`,
          }}
        />
      ))}

      {/* ember-red foreground, bottom-right */}
      {embers.map((e, i) => (
        <div
          key={`e${i}`}
          style={{
            position: 'absolute',
            left: e.x,
            top: e.y,
            width: e.r * 2,
            height: e.r * 1.4,
            borderRadius: '50%',
            background: `radial-gradient(ellipse 50% 50% at 50% 55%, rgba(${e.c},${e.o}) 0%, rgba(${e.c},0.28) 55%, transparent 75%)`,
            filter: 'blur(5px)',
          }}
        />
      ))}
      {sparks.map((s, i) => (
        <div
          key={`s${i}`}
          style={{
            position: 'absolute',
            left: s.x,
            top: s.y,
            width: s.r * 2,
            height: s.r * 2,
            borderRadius: '50%',
            background: i % 3 === 0 ? '#ffb37a' : '#ff3b14',
            opacity: s.o,
          }}
        />
      ))}
      {/* rocky ground */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '20%',
          background:
            'linear-gradient(180deg, transparent 0%, rgba(20,16,12,0.7) 40%, #14100c 70%, #050403 100%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: '-4%',
          bottom: '-6%',
          width: '52%',
          height: '30%',
          background:
            'linear-gradient(200deg, #3d3a38 0%, #232120 35%, #0b0a09 100%)',
          clipPath: 'polygon(20% 45%, 45% 20%, 75% 35%, 100% 10%, 100% 100%, 0% 100%)',
          opacity: 0.9,
        }}
      />
      {/* vignette */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(ellipse 105% 90% at 50% 45%, transparent 55%, rgba(0,0,0,0.55) 100%)',
        }}
      />
      <div style={{position: 'absolute', top: 0, left: 0, right: 0, height: 10, background: '#000'}} />
      <div style={{position: 'absolute', bottom: 0, left: 0, right: 0, height: 10, background: '#000'}} />
    </AbsoluteFill>
  );
};
