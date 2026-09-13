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

/**
 * コースの絞り込み条件。
 *
 * 距離は「ぴったりの値」か「距離帯」のどちらかで指定する。
 * チャンピオンズミーティングは距離帯だけ先に分かってコースが後から決まるので、
 * 帯で引ける口が要る。育成中に「この個体はどのコースなら走れるか」を見る人は、
 * 逆にぴったりの距離で引く。docs/webapp-design.md 6.5 節を参照。
 */
export interface CourseFilter {
  /** 1=芝 2=ダート */
  readonly surface: number;
  /** ぴったりの距離。指定するとこちらが優先される。 */
  readonly distance?: number;
  /** 距離帯。`distance` を指定したときは見ない。 */
  readonly distanceCategory?: Distance;
}

/** 絞り込みに当たった 1 コース。 */
export interface CourseMatch {
  readonly location: number;
  readonly course: number;
  /** レース場の名前（「東京」など） */
  readonly locationName: string;
  readonly detail: TrackDetail;
}

/**
 * 条件に当たるコースをすべて集める。
 *
 * 並びは距離、レース場 ID、コース ID の順に固定する。
 * 表の行がデータの並び順で動くと、走らせ直すたびに行が入れ替わって読めない。
 */
export function matchCourses(
  trackData: Record<number, RaceTrack>,
  filter: CourseFilter,
): CourseMatch[] {
  const matched: CourseMatch[] = [];
  for (const [locationKey, location] of Object.entries(trackData)) {
    for (const [courseKey, detail] of Object.entries(location.courses)) {
      if (detail.surface !== filter.surface) continue;
      if (filter.distance !== undefined) {
        if (detail.distance !== filter.distance) continue;
      } else if (filter.distanceCategory !== undefined) {
        if (detail.distanceCategory !== filter.distanceCategory) continue;
      }
      matched.push({
        location: Number(locationKey),
        course: Number(courseKey),
        locationName: location.name,
        detail,
      });
    }
  }
  matched.sort(
    (a, b) =>
      a.detail.distance - b.detail.distance || a.location - b.location || a.course - b.course,
  );
  return matched;
}

/** バ場ごとに、データが持っている距離の一覧。小さい順で重複は無い。 */
export function courseDistances(
  trackData: Record<number, RaceTrack>,
  surface: number,
): number[] {
  const distances = new Set<number>();
  for (const location of Object.values(trackData)) {
    for (const detail of Object.values(location.courses)) {
      if (detail.surface === surface) distances.add(detail.distance);
    }
  }
  return [...distances].sort((a, b) => a - b);
}

export function getSlope(track: TrackDetail, position: number): number {
  for (const slope of track.slopes) {
    if (position >= slope.start && position <= slope.end) {
      return 0.0001 * slope.slope;
    }
  }
  return 0.0;
}
