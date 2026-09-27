import { Composition } from 'remotion';
import { Poster } from './Poster';
import { Promo, cutFrames } from './Promo';
import { End, Montage, Title } from './scenes/Intro';
import { Everywhere } from './scenes/Everywhere';
import { Photos } from './scenes/Photos';
import { Shortlist } from './scenes/Shortlist';
import { Sweeps } from './scenes/Sweeps';
import { Travel } from './scenes/Travel';
import { Triage } from './scenes/Triage';
import { Verdict } from './scenes/Verdict';

const SCENES = { Montage, Title, Sweeps, Travel, Photos, Verdict, Triage, Shortlist, Everywhere, End };

export function Root() {
  return (
    <>
      {(['60', '45'] as const).map((cut) => (
        <Composition key={cut} id={`Promo${cut}`} component={Promo} defaultProps={{ cut }} durationInFrames={cutFrames(cut)} fps={30} width={1920} height={1080} />
      ))}
      <Composition id="Poster" component={Poster} defaultProps={{ play: false }} durationInFrames={41} fps={30} width={1920} height={1080} />
      <Composition id="PosterPlay" component={Poster} defaultProps={{ play: true }} durationInFrames={41} fps={30} width={1920} height={1080} />
      {Object.entries(SCENES).map(([id, C]) => (
        <Composition key={id} id={`s-${id}`} component={C} durationInFrames={300} fps={30} width={1920} height={1080} />
      ))}
    </>
  );
}
