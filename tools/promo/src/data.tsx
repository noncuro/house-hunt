import type { CSSProperties, ReactNode } from 'react';
import type { Rating } from '@house-hunt/core';
import { VerdictStamp } from '@house-hunt/ui';
import { Photo, type HomePhoto } from './kit';
import { C, FONT } from './theme';

/** Invented flats on real London streets. No listing and no person is real, and the
 *  photographs are generated (`public/homes/`), not taken from any listing. */
export interface Flat {
  id: string;
  street: string;
  area: string;
  beds: number;
  price: string;
  photo: HomePhoto;
  rating: Rating | null;
  score: number;
  /** Position on the drawn map, in its 900×560 viewBox. */
  at: [number, number];
}

export const FLATS: Flat[] = [
  { id: 'a', street: 'Mildmay Grove', area: 'N1', beds: 2, price: '£2,450', photo: 'street', rating: 'love', score: 0.86, at: [560, 185] },
  { id: 'b', street: 'Elgin Avenue', area: 'W9', beds: 2, price: '£2,300', photo: 'mansion', rating: 'no', score: 0.22, at: [255, 230] },
  { id: 'c', street: 'Chatsworth Road', area: 'E5', beds: 2, price: '£2,150', photo: 'kitchen', rating: 'maybe', score: 0.64, at: [705, 130] },
  { id: 'd', street: 'Lordship Lane', area: 'SE22', beds: 2, price: '£2,050', photo: 'living', rating: null, score: 0.51, at: [620, 460] },
  { id: 'e', street: 'Agar Grove', area: 'NW1', beds: 2, price: '£2,600', photo: 'canal', rating: 'love', score: 0.81, at: [470, 190] },
  { id: 'f', street: 'Brixton Water Lane', area: 'SW2', beds: 2, price: '£2,200', photo: 'bedroom', rating: null, score: 0.38, at: [430, 468] },
];

export const PIN: Record<string, string> = {
  love: C.loved,
  maybe: C.liked,
  no: C.rejected,
  none: C.unrated,
};

export function verdictOf(rating: Rating | null, person = 'Jo') {
  return rating ? { rating, person, updatedAt: new Date(Date.now() - 3 * 3600e3).toISOString(), note: '' } : null;
}

/** The shortlist card, drawn at video scale: photograph, verdict stamp, address, the key facts. */
export function FlatCard({
  flat,
  width = 440,
  imageHeight = 230,
  stamp = true,
  children,
  style,
}: {
  flat: Flat;
  width?: number;
  imageHeight?: number;
  stamp?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        width,
        background: C.raised,
        border: `1px solid ${C.line}`,
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 24px 60px rgba(36,31,26,0.13), 0 4px 12px rgba(36,31,26,0.05)',
        ...style,
      }}
    >
      <div style={{ height: imageHeight, position: 'relative' }}>
        <Photo name={flat.photo} />
        {stamp && flat.rating && (
          <div style={{ position: 'absolute', left: 14, top: 14, zoom: width / 300 }}>
            <VerdictStamp verdict={verdictOf(flat.rating) as never} />
          </div>
        )}
      </div>
      <div style={{ padding: `${width / 24}px ${width / 18}px ${width / 20}px` }}>
        <div style={{ fontFamily: FONT.serif, fontWeight: 600, fontSize: width / 13.5, letterSpacing: '-0.01em', lineHeight: 1.15 }}>
          {flat.street}, {flat.area}
        </div>
        <div style={{ fontFamily: FONT.mono, fontSize: width / 30, color: C.muted, marginTop: 6, letterSpacing: '0.04em' }}>
          {flat.beds} BED · {flat.price} PCM
        </div>
        {children}
      </div>
    </div>
  );
}
