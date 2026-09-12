import type { Condition, FitRank, Style } from '../../../packages/sim/src/data/constants.ts';
import type {
  PositionKeepMode,
  RandomPosition,
  SkillActivateAdjustment,
  TrackRef,
  UmaStatus,
} from '../../../packages/sim/src/setting.ts';

/**
 * 設定を URL のハッシュに載せるための符号化。
 *
 * JSON をそのまま base64 にすると鍵の名前で長くなるので、位置で並べた
 * 文字列にしてから符号化する。スキル ID の並びが長さの大半を占める。
 */

export interface ShareOptions {
  readonly skillActivateAdjustment: SkillActivateAdjustment;
  readonly randomPosition: RandomPosition;
  readonly positionKeepMode: PositionKeepMode;
  readonly positionKeepRate: number;
}

export interface ShareState {
  readonly uma: UmaStatus;
  readonly track: TrackRef;
  readonly skillIds: readonly string[];
  readonly count: number;
  readonly seed: number;
  readonly options: ShareOptions;
  readonly debuffCounts: Readonly<Record<string, number>>;
  readonly hintLevels: Readonly<Record<string, number>>;
  readonly useField: boolean;
}

const STYLES: Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];
const CONDITIONS: Condition[] = ['BEST', 'GOOD', 'NORMAL', 'BAD', 'WORST'];
const FITS: FitRank[] = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
const ADJUSTMENTS: SkillActivateAdjustment[] = ['NONE', 'YES', 'ALL'];
const RANDOM_POSITIONS: RandomPosition[] = ['RANDOM', 'FASTEST', 'FAST', 'MIDDLE', 'SLOW', 'SLOWEST'];
const KEEP_MODES: PositionKeepMode[] = ['APPROXIMATE', 'VIRTUAL', 'SPEED_UP', 'NONE'];

/**
 * 版 1 は実行オプションを持たない。版 2 で足した。
 * 既に配ったリンクを壊さないため、読み取りは版 1 も受け付け、
 * 足りない項目は既定値で埋める。
 */
const VERSION = '2';

export function defaultShareOptions(): ShareOptions {
  return {
    skillActivateAdjustment: 'NONE',
    randomPosition: 'RANDOM',
    positionKeepMode: 'APPROXIMATE',
    positionKeepRate: 100,
  };
}

/** `id:値` を `;` で連ねる。値が 0 の項目は書かない。 */
function encodeCounts(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([id, value]) => `${id}:${value}`)
    .join(';');
}

function decodeCounts(text: string | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  if (text === undefined || text === '') return result;
  for (const pair of text.split(';')) {
    const [id, raw] = pair.split(':');
    const value = Number(raw);
    if (id !== undefined && id !== '' && Number.isFinite(value) && value > 0) result[id] = value;
  }
  return result;
}

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
    // 季節と天候と時刻は後から足した。0 は指定なしで、古いリンクにはこの 3 つが無い。
    [
      track.location,
      track.course,
      track.condition,
      track.gateCount,
      track.season ?? 0,
      track.weather ?? 0,
      track.time ?? 0,
    ].join(','),
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
    [
      ADJUSTMENTS.indexOf(state.options.skillActivateAdjustment),
      RANDOM_POSITIONS.indexOf(state.options.randomPosition),
      KEEP_MODES.indexOf(state.options.positionKeepMode),
      state.options.positionKeepRate,
      state.useField ? 1 : 0,
    ].join(','),
    encodeCounts(state.debuffCounts),
    encodeCounts(state.hintLevels),
  ];
  return toBase64Url(fields.join('|'));
}

export function decodeShareState(encoded: string): ShareState | null {
  try {
    const parts = fromBase64Url(encoded).split('|');
    if ((parts[0] !== VERSION && parts[0] !== '1') || parts.length < 5) return null;
    const track = parts[1]!.split(',').map(Number);
    const uma = parts[2]!.split(',').map(Number);
    const skillIds = parts[3] === '' ? [] : parts[3]!.split(',');
    const run = parts[4]!.split(',').map(Number);
    const option = (parts[5] ?? '').split(',').map(Number);
    const options: ShareOptions =
      parts[5] === undefined || parts[5] === ''
        ? defaultShareOptions()
        : {
            skillActivateAdjustment: ADJUSTMENTS[option[0]!] ?? 'NONE',
            randomPosition: RANDOM_POSITIONS[option[1]!] ?? 'RANDOM',
            positionKeepMode: KEEP_MODES[option[2]!] ?? 'APPROXIMATE',
            positionKeepRate: Number.isFinite(option[3]) ? option[3]! : 100,
          };
    return {
      track: {
        location: track[0]!,
        course: track[1]!,
        condition: track[2]!,
        gateCount: track[3]!,
        season: track[4] ? track[4] : undefined,
        weather: track[5] ? track[5] : undefined,
        time: track[6] ? track[6] : undefined,
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
      options,
      debuffCounts: decodeCounts(parts[6]),
      hintLevels: decodeCounts(parts[7]),
      useField: option[4] === 1,
    };
  } catch {
    return null;
  }
}
