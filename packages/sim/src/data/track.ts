import { courseWidth, type Distance } from './constants.ts';

export interface Corner {
  readonly start: number;
  readonly length: number;
  readonly end: number;
}

export interface Straight {
  readonly start: number;
  readonly end: number;
}

export interface Slope {
  readonly start: number;
  readonly length: number;
  readonly slope: number;
  readonly end: number;
}

export interface TrackDetail {
  readonly raceTrackId: number;
  readonly name: string;
  readonly distance: number;
  /** 1=短距離 2=マイル 3=中距離 4=長距離 */
  readonly distanceType: number;
  /** 1=芝 2=ダート */
  readonly surface: number;
  readonly turn: number;
  readonly courseSetStatus: readonly number[];
  readonly laneMax: number;
  readonly finishTimeMin: number;
  readonly finishTimeMax: number;
  readonly corners: readonly Corner[];
  readonly straights: readonly Straight[];
  readonly slopes: readonly Slope[];
  readonly tightTrack: number;
  readonly runUp: number;
  readonly isBasisDistance: number;
  readonly distanceCategory: Distance;
  readonly maxLaneDistance: number;
  readonly moveLanePoint: number;
  readonly isDirtGrade: boolean;
}

export interface RaceTrack {
  readonly name: string;
  readonly courses: Record<number, TrackDetail>;
}

interface RawCorner {
  start: number;
  length: number;
}
interface RawSlope {
  start: number;
  length: number;
  slope: number;
}
interface RawTrackDetail {
  raceTrackId: number;
  name: string;
  distance: number;
  distanceType: number;
  surface: number;
  turn: number;
  courseSetStatus: number[];
  laneMax: number;
  finishTimeMin: number;
  finishTimeMax: number;
  corners: RawCorner[];
  straights: Straight[];
  slopes: RawSlope[];
  tightTrack: number;
  runUp: number;
}

function distanceCategory(distanceType: number): Distance {
  switch (distanceType) {
    case 1:
      return 'SHORT';
    case 2:
      return 'MILE';
    case 3:
      return 'MIDDLE';
    case 4:
      return 'LONG';
    default:
      throw new Error(`unknown distance type: ${distanceType}`);
  }
}

function buildTrackDetail(raw: RawTrackDetail): TrackDetail {
  const corners: Corner[] = raw.corners.map((c) => ({
    start: c.start,
    length: c.length,
    end: c.start + c.length,
  }));
  const slopes: Slope[] = raw.slopes.map((s) => ({
    start: s.start,
    length: s.length,
    slope: s.slope,
    end: s.start + s.length,
  }));
  return {
    raceTrackId: raw.raceTrackId,
    name: raw.name,
    distance: raw.distance,
    distanceType: raw.distanceType,
    surface: raw.surface,
    turn: raw.turn,
    courseSetStatus: raw.courseSetStatus,
    laneMax: raw.laneMax,
    finishTimeMin: raw.finishTimeMin,
    finishTimeMax: raw.finishTimeMax,
    corners,
    straights: raw.straights,
    slopes,
    tightTrack: raw.tightTrack,
    runUp: raw.runUp,
    isBasisDistance: raw.distance % 400 === 0 ? 1 : 0,
    distanceCategory: distanceCategory(raw.distanceType),
    maxLaneDistance: (courseWidth * raw.laneMax) / 10000.0,
    moveLanePoint: corners.length > 0 ? corners[0]!.start : 30.0,
    isDirtGrade: raw.raceTrackId >= 10101,
  };
}

export function buildTrackData(
  raw: Record<string, { name: string; courses: Record<string, RawTrackDetail> }>,
): Record<number, RaceTrack> {
  const result: Record<number, RaceTrack> = {};
  for (const [locationId, location] of Object.entries(raw)) {
    const courses: Record<number, TrackDetail> = {};
    for (const [courseId, course] of Object.entries(location.courses)) {
      courses[Number(courseId)] = buildTrackDetail(course);
    }
    result[Number(locationId)] = { name: location.name, courses };
  }
  return result;
}

export function getSlope(track: TrackDetail, position: number): number {
  for (const slope of track.slopes) {
    if (position >= slope.start && position <= slope.end) {
      return 0.0001 * slope.slope;
    }
  }
  return 0.0;
}
