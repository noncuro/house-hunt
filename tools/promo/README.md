# promo — the video at househunt.london/promo and at the top of the README

A [Remotion](https://www.remotion.dev) project. It renders two cuts from the same scenes: the
45-second one the site serves (`apps/web/public/promo.mp4`) and a 60-second one that adds the
shortlist chapter. Both open on a montage of homes cut to the beat, then the name, then the product.

It draws the product's own components rather than a lookalike: `@house-hunt/ui` and `@house-hunt/core`
are aliased straight to `packages/` in `remotion.config.ts`, and `tokens.css` is imported as-is, so
a verdict stamp, a flag chip or a journey leg in the video is the one the website renders. When those
change, re-render and the video follows.

What it does not use, on purpose:

- **No listing photographs.** They are never re-hosted (see the root `AGENTS.md`). The homes in
  `public/homes/` are generated images (`gpt-image-2`), not photographs of any real listing.
- **No real people or addresses.** The flats are invented, on real London streets; Sam and Jo are
  nobody.
- **No licensed music.** `music/make_music.py` synthesises each cut's soundtrack.

## Cuts

`src/cuts.json` holds each cut's scenes, their lengths and its fade. Scenes are timed for the
60-second cut; a shorter cut plays each scene faster (`Pace` in `src/kit.tsx`) rather than cutting it
off, so a scene reads its clock from `useFrame()`, never `useCurrentFrame()`. The music script reads
the same file, so a changed scene length moves the score with it — run `pnpm music` after editing.
The montage is the exception: it is the same length in both cuts, because its shots are cut on the
score's beat.

The app icon in the video is the `Mark` component from `@house-hunt/ui`, drawn from the shapes in
`packages/ui/src/mark.ts` that `pnpm icons` rasterises for the website, so the two cannot drift. The
title's magnifying glass follows the same `SPLASH` keyframes as the app's launch splash.

## Rendering

Its own pnpm root (the local `pnpm-workspace.yaml`), so installing here does not touch the
workspace's lockfile.

```bash
cd tools/promo
pnpm install
pnpm music          # public/music-45.wav and music-60.wav (needs uv)
pnpm studio         # scrub it in a browser
pnpm render         # the 45-second cut to apps/web/public/promo.mp4, and both posters
pnpm render:60      # the 60-second cut to out/
```

Rendering is Chrome taking a screenshot of every frame: about seven minutes for the 45-second cut
on four cores. Each scene is also registered on its own (`s-Travel`, `s-Photos`, …) for checking a
frame:

```bash
pnpm exec remotion still s-Photos out/photos.png --frame=150
```

`promo.jpg` is the end card, the `<video>` poster on the site; `promo-play.jpg` is the same with a
play button, for the README.
