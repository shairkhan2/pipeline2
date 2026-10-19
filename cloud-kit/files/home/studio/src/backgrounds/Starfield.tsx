import React, {useMemo} from 'react';
import {AbsoluteFill} from 'remotion';

export const W = 1280;
export const H = 720;

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

export const Starfield: React.FC = () => {
  const stars = useMemo(() => {
    const rnd = mulberry(1337);
    return Array.from({length: 220}, () => ({
      x: rnd() * W,
      y: rnd() * H,
      r: 0.6 + rnd() * 1.8,
      a: 0.25 + rnd() * 0.65,
    }));
  }, []);
  return (
    <AbsoluteFill
      style={{
        background:
          'radial-gradient(ellipse 90% 45% at 50% 55%, #0e3a52 0%, #081c30 45%, #040b18 100%)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: '-10%',
          right: '-10%',
          top: '38%',
          height: '24%',
          background:
            'linear-gradient(180deg, transparent, rgba(34,211,238,0.20) 35%, rgba(34,211,238,0.32) 50%, rgba(34,211,238,0.20) 65%, transparent)',
          filter: 'blur(18px)',
        }}
      />
      {stars.map((s, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: s.x,
            top: s.y,
            width: s.r * 2,
            height: s.r * 2,
            borderRadius: '50%',
            background: '#cfe9ff',
            opacity: s.a,
          }}
        />
      ))}
      <div style={{position: 'absolute', top: 0, left: 0, right: 0, height: 10, background: '#000'}} />
      <div style={{position: 'absolute', bottom: 0, left: 0, right: 0, height: 10, background: '#000'}} />
    </AbsoluteFill>
  );
};
