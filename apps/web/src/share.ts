import type { Condition, FitRank, Style } from '../../../packages/sim/src/data/constants.ts';
import type { TrackRef, UmaStatus } from '../../../packages/sim/src/setting.ts';

/**
 * 設定を URL のハッシュに載せるための符号化。
 *
 * JSON をそのまま base64 にすると鍵の名前で長くなるので、位置で並べた
 * 文字列にしてから符号化する。スキル ID の並びが長さの大半を占める。
 */

export interface ShareState {
  readonly uma: UmaStatus;
  readonly track: TrackRef;
  readonly skillIds: readonly string[];
  readonly count: number;
  readonly seed: number;
}

const STYLES: Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];
const CONDITIONS: Condition[] = ['BEST', 'GOOD', 'NORMAL', 'BAD', 'WORST'];
const FITS: FitRank[] = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

const VERSION = '1';

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeShareState(state: ShareState): string {
  const { uma, track } = state;
  const fields = [
    VERSION,
    [track.location, track.course, track.condition, track.gateCount].join(','),
    [
      uma.speed,
      uma.stamina,
      uma.power,
      uma.guts,
      uma.wisdom,
      CONDITIONS.indexOf(uma.condition),
      STYLES.indexOf(uma.style),
      FITS.indexOf(uma.distanceFit),
      FITS.indexOf(uma.surfaceFit),
      FITS.indexOf(uma.styleFit),
      uma.popularity,
      uma.gateNumber,
      uma.uniqueLevel,
    ].join(','),
    state.skillIds.join(','),
    [state.count, state.seed].join(','),
  ];
  return toBase64Url(fields.join('|'));
}

export function decodeShareState(encoded: string): ShareState | null {
  try {
    const parts = fromBase64Url(encoded).split('|');
    if (parts[0] !== VERSION || parts.length < 5) return null;
    const track = parts[1]!.split(',').map(Number);
    const uma = parts[2]!.split(',').map(Number);
    const skillIds = parts[3] === '' ? [] : parts[3]!.split(',');
    const run = parts[4]!.split(',').map(Number);
    return {
      track: {
        location: track[0]!,
        course: track[1]!,
        condition: track[2]!,
        gateCount: track[3]!,
      },
      uma: {
        charaName: '',
        speed: uma[0]!,
        stamina: uma[1]!,
        power: uma[2]!,
        guts: uma[3]!,
        wisdom: uma[4]!,
        condition: CONDITIONS[uma[5]!] ?? 'BEST',
        style: STYLES[uma[6]!] ?? 'SEN',
        distanceFit: FITS[uma[7]!] ?? 'A',
        surfaceFit: FITS[uma[8]!] ?? 'A',
        styleFit: FITS[uma[9]!] ?? 'A',
        popularity: uma[10]!,
        gateNumber: uma[11]!,
        uniqueLevel: uma[12]!,
      },
      skillIds,
      count: run[0]!,
      seed: run[1]!,
    };
  } catch {
    return null;
  }
}
