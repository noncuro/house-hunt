import './icon.css';

/** One monochrome line-drawn set, for every glyph either surface draws.
 *
 *  These were emoji. Eleven of them — bed, bath, bathtub, star, leaf, plate, warning, walk, bike,
 *  train, pin — and every one of them rendered as a different picture on a different operating
 *  system, sat a few pixels off the text baseline, and could not be recoloured, so a flag saying
 *  "no bathtub" carried a cheerful blue bath beside the word "no". A glyph that cannot take the
 *  colour of the thing it is marking is a glyph arguing with its own label.
 *
 *  All of them are drawn in a 16-unit box on the same 1.5 stroke, take `currentColor`, and carry no
 *  accessible name of their own: every one of them sits beside the words it illustrates, so a name
 *  here would be the same fact read out twice. Where an icon is genuinely alone — the travel grid's
 *  column heads — the caller supplies a `label`, and that is the only case.
 *
 *  Adding one: draw it inside `0 0 16 16`, no fills, and let the stroke come from the wrapper. */
export type IconName =
  | 'bed'
  | 'bath'
  | 'bathtub'
  | 'room'
  | 'outdoor'
  | 'dishwasher'
  | 'laundry'
  | 'light'
  | 'bills'
  | 'floorplan'
  | 'size'
  | 'warning'
  | 'blocked'
  | 'absent'
  | 'walking'
  | 'cycling'
  | 'transit'
  | 'crow'
  | 'pin'
  | 'station'
  | 'chevron'
  | 'places'
  | 'triage'
  | 'map'
  | 'hunt'
  | 'external'
  | 'tick'
  | 'close'
  | 'back'
  | 'forward'
  | 'filter'
  | 'sort'
  | 'columns'
  | 'twin'
  | 'pencil'
  | 'plus';

/** The path data, and nothing else. Kept as a plain table so a glyph is one line to read and one
 *  line to change, rather than a component apiece. */
const PATHS: Record<IconName, React.ReactNode> = {
  bed: <path d="M1.5 12.5V4.5m0 4h13v4m-13-4V9m2-1.5V5.5h4v2" />,
  bath: <path d="M2 8h12v2a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V8zM8 8V3.2a1.2 1.2 0 0 1 2.4 0M4.5 13l-1 1.6M11.5 13l1 1.6" />,
  bathtub: <path d="M2 8h12v2a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V8zM4 8V3.5a1.5 1.5 0 0 1 3 0" />,
  room: <path d="m8 2 1.8 3.8 4 .5-3 2.8.8 4L8 11.2 4.4 13l.8-4-3-2.8 4-.5L8 2z" />,
  outdoor: <path d="M3 13C3 6.5 8 3 13 3c0 5-3 10-10 10zM3 13c2-4 5-6 7-7" />,
  dishwasher: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <circle cx="8" cy="9" r="2.6" />
      <path d="M2.5 5.5h11" />
    </>
  ),
  laundry: <path d="M3 3.2h10l-1 10.6a1 1 0 0 1-1 .9H5a1 1 0 0 1-1-.9L3 3.2zM3.6 7h8.8M5.5 1.5h5" />,
  light: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.4M8 13.1v1.4M14.5 8h-1.4M2.9 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1" />
    </>
  ),
  bills: <path d="M8 1.8a4 4 0 0 1 2.4 7.2c-.5.4-.8 1-.8 1.6v.4h-3.2v-.4c0-.6-.3-1.2-.8-1.6A4 4 0 0 1 8 1.8zM6.4 13.4h3.2M7 14.8h2" />,
  floorplan: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M7 2.5v5M7 7.5h7M10 7.5v6" />
    </>
  ),
  size: <path d="M2.5 2.5h11v11h-11zM5.5 13.5v-3h3" />,
  warning: <path d="M8 2.2 14.3 13H1.7L8 2.2zM8 6.5V10M8 11.7h.01" />,
  blocked: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="m4 12 8-8" />
    </>
  ),
  absent: <path d="M4 4l8 8M12 4l-8 8" />,
  walking: (
    <>
      <circle cx="8" cy="2.8" r="1.3" />
      <path d="M8 5.2v4l-2 4.3M8 9.2l2 4.3M8 6.2 5.6 7.8M8 6.2l2.4 1.4" />
    </>
  ),
  cycling: (
    <>
      <circle cx="4" cy="11" r="2.4" />
      <circle cx="12" cy="11" r="2.4" />
      <path d="M4 11l3-6h3l2 6M7 5H5.4" />
    </>
  ),
  transit: (
    <>
      <rect x="4" y="1.8" width="8" height="9" rx="2" />
      <path d="M4 7.8h8M6 12.8l-1.4 1.7M10 12.8l1.4 1.7" />
    </>
  ),
  crow: <path d="M2 11.5 14 4M2 11.5v-2.5M2 11.5h2.5M14 4v2.5M14 4h-2.5" />,
  pin: (
    <>
      <path d="M8 14.2s4.6-4.3 4.6-7.6a4.6 4.6 0 1 0-9.2 0c0 3.3 4.6 7.6 4.6 7.6z" />
      <circle cx="8" cy="6.4" r="1.7" />
    </>
  ),
  station: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M2.4 8h11.2" />
    </>
  ),
  chevron: <path d="m4 6 4 4 4-4" />,
  places: <path d="M2.5 7.5 8 2.5l5.5 5v6h-11v-6z" />,
  triage: <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" />,
  map: <path d="M2.5 4 6 2.5l4 1.5 3.5-1.5v10L10 14l-4-1.5-3.5 1.5v-10zM6 2.5v10M10 4v10" />,
  hunt: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2v1.6M8 12.4V14M14 8h-1.6M3.6 8H2M12.3 3.7l-1.2 1.2M4.9 11.1l-1.2 1.2M12.3 12.3l-1.2-1.2M4.9 4.9 3.7 3.7" />
    </>
  ),
  external: <path d="M9.5 2.5H13.5V6.5M13.5 2.5 7.5 8.5M11.5 9.5v3.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3.5" />,
  tick: <path d="m3 8.4 3.2 3.2L13 4.8" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  back: <path d="M9.5 3 4.5 8l5 5M4.5 8h7.5" />,
  forward: <path d="M6.5 3l5 5-5 5M11.5 8H4" />,
  filter: <path d="M2 4h12M4.5 8h7M7 12h2" />,
  sort: <path d="M5 3v10M5 13 2.8 10.5M5 13l2.2-2.5M11 13V3M11 3 8.8 5.5M11 3l2.2 2.5" />,
  columns: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M6 2.5v11M10 2.5v11" />
    </>
  ),
  twin: (
    <>
      <rect x="2.5" y="4.5" width="8" height="8" rx="1" />
      <path d="M5.5 4.5v-1a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1" />
    </>
  ),
  pencil: <path d="M11.2 2.3a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5l-3 .8.8-3 7.8-8z" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
};

export function Icon({
  name,
  size = 14,
  label,
  className,
}: {
  name: IconName;
  size?: number;
  /** Only where the icon stands alone. Beside its own words it is decorative, and naming it there
   *  makes a screen reader say the same thing twice. */
  label?: string;
  className?: string;
}) {
  return (
    <svg
      className={className ? `rm-icon ${className}` : 'rm-icon'}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {PATHS[name]}
    </svg>
  );
}
