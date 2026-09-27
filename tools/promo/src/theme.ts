import { loadFont as loadSerif } from '@remotion/google-fonts/Newsreader';
import { loadFont as loadSans } from '@remotion/google-fonts/IBMPlexSans';
import { loadFont as loadMono } from '@remotion/google-fonts/IBMPlexMono';

// The same three faces the website self-hosts through next/font, each doing the same job:
// Newsreader for names of places, Plex Sans for prose, Plex Mono for the labels over facts.
const serif = loadSerif('normal', { weights: ['400', '500', '600'], subsets: ['latin'] });
loadSerif('italic', { weights: ['400', '500'], subsets: ['latin'] });
const sans = loadSans('normal', { weights: ['400', '500', '600'], subsets: ['latin'] });
const mono = loadMono('normal', { weights: ['400', '500'], subsets: ['latin'] });

export const FONT = {
  serif: `${serif.fontFamily}, Georgia, serif`,
  sans: `${sans.fontFamily}, system-ui, sans-serif`,
  mono: `${mono.fontFamily}, ui-monospace, monospace`,
};

// tokens.css reads these `-loaded` variables, which next/font sets on the website's <html>.
export const FONT_VARS = {
  '--font-serif-loaded': serif.fontFamily,
  '--font-sans-loaded': sans.fontFamily,
  '--font-mono-loaded': mono.fontFamily,
} as React.CSSProperties;

// Literal copies of tokens.css for the places a CSS variable cannot reach (SVG gradients, canvas).
export const C = {
  ink: '#241f1a',
  inkSoft: '#453e33',
  muted: '#6e6659',
  faint: '#9a927f',
  fainter: '#b3aca0',
  line: '#e5e0d6',
  line2: '#eae6de',
  line3: '#f0ece3',
  paper: '#faf8f4',
  raised: '#fdfcfa',
  green: '#1a7f5a',
  loved: 'oklch(0.55 0.12 155)',
  liked: 'oklch(0.55 0.12 85)',
  unrated: 'oklch(0.55 0.09 240)',
  rejected: '#b3aca0',
  goodBg: 'oklch(0.95 0.03 155)',
  goodInk: 'oklch(0.38 0.09 155)',
  warnBg: '#faf3e3',
  warnInk: '#8a6d1f',
  badBg: 'oklch(0.96 0.02 25)',
  badInk: 'oklch(0.48 0.11 25)',
};

export const FPS = 30;
export const W = 1920;
export const H = 1080;
