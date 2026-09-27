import type { ComponentType } from 'react';
import { Audio, staticFile } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import CUTS from './cuts.json';
import { Pace } from './kit';
import { End, Montage, Title } from './scenes/Intro';
import { Everywhere } from './scenes/Everywhere';
import { Photos } from './scenes/Photos';
import { Shortlist } from './scenes/Shortlist';
import { Sweeps } from './scenes/Sweeps';
import { Travel } from './scenes/Travel';
import { Triage } from './scenes/Triage';
import { Verdict } from './scenes/Verdict';

export type Cut = '60' | '45';

const SCENES: Record<string, ComponentType> = { Montage, Title, Sweeps, Travel, Photos, Verdict, Triage, Shortlist, Everywhere, End };
const WRITTEN_AT = CUTS['60'].scenes as Record<string, number>;

export function cutFrames(cut: Cut): number {
  const { fade: overlap, scenes } = CUTS[cut];
  const lengths = Object.values(scenes);
  return lengths.reduce((n, f) => n + f, 0) - overlap * (lengths.length - 1);
}

export function Promo({ cut }: { cut: Cut }) {
  const { fade: overlap, scenes } = CUTS[cut];
  const names = Object.keys(scenes) as Array<keyof typeof scenes>;
  return (
    <>
      <TransitionSeries>
        {names.flatMap((name, i) => {
          const Scene = SCENES[name];
          const frames = scenes[name];
          return [
            <TransitionSeries.Sequence key={`s${name}`} durationInFrames={frames}>
              <Pace value={WRITTEN_AT[name] / frames}>
                <Scene />
              </Pace>
            </TransitionSeries.Sequence>,
            i < names.length - 1 ? (
              <TransitionSeries.Transition key={`t${name}`} presentation={fade()} timing={linearTiming({ durationInFrames: overlap })} />
            ) : null,
          ];
        })}
      </TransitionSeries>
      <Audio src={staticFile(`music-${cut}.wav`)} />
    </>
  );
}
