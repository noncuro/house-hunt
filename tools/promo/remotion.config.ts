import path from 'node:path';
import { Config } from '@remotion/cli/config';
import webpack from 'webpack';

// The video draws the product's own components and palette rather than a lookalike, so the two
// workspace packages are aliased straight to their source in this repo.
const HOUSE_HUNT = path.resolve(process.cwd(), '../..');
const here = path.resolve(process.cwd(), 'node_modules');

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setConcurrency(2);
Config.setCodec('h264');
Config.setCrf(20);
Config.setX264Preset('slow');
Config.setPixelFormat('yuv420p');

// The packages' .tsx files sit outside this project, where the bundler compiles JSX with the classic
// runtime; providing React globally is what that runtime expects.
Config.overrideWebpackConfig((config) => ({
  ...config,
  plugins: [...(config.plugins ?? []), new webpack.ProvidePlugin({ React: 'react' })],
  resolve: {
    ...config.resolve,
    modules: [here, 'node_modules'],
    alias: {
      ...config.resolve?.alias,
      '@house-hunt/ui/tokens.css': path.join(HOUSE_HUNT, 'packages/ui/src/tokens.css'),
      '@house-hunt/ui': path.join(HOUSE_HUNT, 'packages/ui/src/index.ts'),
      '@house-hunt/core': path.join(HOUSE_HUNT, 'packages/core/src/index.ts'),
      react: path.join(here, 'react'),
      'react-dom': path.join(here, 'react-dom'),
    },
  },
}));
