import React from 'react';
import {Composition} from 'remotion';
import {Recap, calculateRecapMetadata} from './Recap';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Recap"
      component={Recap}
      width={1280}
      height={720}
      fps={30}
      defaultProps={{shots: [], audio: '', background: 'starfield', motion: 'cut'}}
      calculateMetadata={calculateRecapMetadata}
    />
  );
};
