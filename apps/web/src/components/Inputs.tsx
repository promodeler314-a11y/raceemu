import { useMemo, useState } from 'react';
import { FIT_RANKS, type Condition, type FitRank, type Style } from '../../../../packages/sim/src/data/constants.ts';
import { getSlope, type TrackDetail } from '../../../../packages/sim/src/data/track.ts';
import {
  costModelFor,
  currentTrackDetail,
  debuffTypes,
  estimateRun,
  gameData,
  modifiedStatus,
  skillChoices,
  useStore,
} from '../store.ts';
import { formatDuration } from '../format.ts';
import { NO_CHARA, skillIndex } from '../skills.ts';
import type { SkillData } from '../../../../packages/sim/src/skill/types.ts';
import type {
  PositionKeepMode,
  RandomPosition,
  SkillActivateAdjustment,
} from '../../../../packages/sim/src/setting.ts';

const labelCls = 'block text-xs text-ink3';
const fieldCls =
  'w-full rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  );
}

/**
 * 区切りの付け方は置き場所で変える。
 *
 * 結果の側は地の色（paper）の上に置くので、枠のある箱にする。
 * 設定の列は既に surface の面なので、そこに箱を重ねると枠が二重になる。
 * モックに合わせて、見出しの下の罫線だけで区切る。
 */
/**
 * 分割ボタン。
 *
 * 選択肢が少ないものは `<select>` より速い。開かなくても全部見えるので、
 * いま何が選べるのかと、どれを選んでいるのかが同時に分かる。
 * モックが脚質・やる気・バ場状態・実行オプションでこの形を採っている。
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-ink3">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex h-[30px] overflow-hidden rounded-sm border border-rule2"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            // 「良」のように 1 文字の選択肢は、単独だと何の設定か分からない。
            // 群の名前を添えて読み上げる。
            aria-label={`${label} ${option.label}`}
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className={`flex flex-1 items-center justify-center border-r border-rule px-1 text-xs last:border-r-0 ${
              value === option.value
                ? 'bg-acc-tint font-semibold text-acc-ink'
                : 'bg-surface text-ink2'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * コース形状の小さな図。
 *
 * 「コーナー 4」と字で書いてあっても、どこに来るのかは分からない。
 * コーナーを帯で、勾配を線で出す。詳細の面にある大きな図と同じものを
 * 縮めたわけではなく、設定を決めるときに要る情報だけを残している。
 */
function CourseShape({ detail }: { detail: TrackDetail }) {
  const length = detail.distance;
  const x = (position: number) => (position / length) * 100;
  // 勾配は区間ごとに与えられる。無い区間は 0 として折れ線にする。
  const points: string[] = [];
  const step = length / 60;
  for (let i = 0; i <= 60; i++) {
    const position = i * step;
    const slope = getSlope(detail, position);
    // 上りを上に描く。値は本家の内部値で、±2 程度に収まる。
    points.push(`${x(position)},${10 - Math.max(-3, Math.min(3, slope)) * 2}`);
  }
  return (
    <div className="rounded-sm border border-rule bg-sunken px-2 py-2">
      <div className="flex items-baseline justify-between text-[11px] text-ink3">
        <span>コース形状</span>
        <span>
          {detail.turn === 1 ? '右回り' : '左回り'} ・ コーナー {detail.corners.length} ・ 直線{' '}
          {Math.round(detail.straights.reduce((a, b) => Math.max(a, b.end - b.start), 0))}m
        </span>
      </div>
      <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="mt-1 h-12 w-full">
        {detail.corners.map((corner, i) => (
          <rect
            key={i}
            x={x(corner.start)}
            y={0}
            width={x(corner.end) - x(corner.start)}
            height={20}
            className="fill-rule2 opacity-40"
          >
            <title>
              コーナー {i + 1}: {Math.round(corner.start)} から {Math.round(corner.end)} m
            </title>
          </rect>
        ))}
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.6}
          className="text-ink2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between text-[11px] text-ink3">
        <span>0m</span>
        <span className="num">{length}m</span>
      </div>
    </div>
  );
}

export function Panel({
  title,
  variant = 'card',
  children,
}: {
  title: string;
  variant?: 'card' | 'plain';
  children: React.ReactNode;
}) {
  if (variant === 'plain') {
    return (
      <section className="flex flex-col gap-2.5">
        <h2 className="flex h-[34px] items-center border-b border-rule text-[13px] font-semibold">
          {title}
        </h2>
        {children}
      </section>
    );
  }
  return (
    <section className="rounded-sm border border-rule bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function CourseInput() {
  const track = useStore((s) => s.track);
  const setTrack = useStore((s) => s.setTrack);
  const locations = Object.entries(gameData.trackData);
  const courses = Object.entries(gameData.trackData[track.location]?.courses ?? {});
  const detail = currentTrackDetail(track);

  return (
    <Panel title="コース" variant="plain">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="レース場">
          <select
            className={fieldCls}
            value={track.location}
            onChange={(e) => {
              const location = Number(e.target.value);
              const first = Number(Object.keys(gameData.trackData[location]!.courses)[0]);
              setTrack({ location, course: first });
            }}
          >
            {locations.map(([id, t]) => (
              <option key={id} value={id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="コース">
          <select
            className={fieldCls}
            value={track.course}
            onChange={(e) => setTrack({ course: Number(e.target.value) })}
          >
            {courses.map(([id, c]) => (
              <option key={id} value={id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Segmented
          label="バ場状態"
          value={String(track.condition)}
          options={[
            { value: '1', label: '良' },
            { value: '2', label: '稍重' },
            { value: '3', label: '重' },
            { value: '4', label: '不良' },
          ]}
          onChange={(value) => setTrack({ condition: Number(value) })}
        />
        <Field label="出走頭数">
          <select
            className={fieldCls}
            value={track.gateCount}
            onChange={(e) => setTrack({ gateCount: Number(e.target.value) })}
          >
            <option value={9}>9 頭（チャンピオンズミーティング）</option>
            <option value={12}>12 頭（リーグオブヒーローズ）</option>
          </select>
        </Field>
        {/*
          季節と天候と時刻は、本家が「満たしている前提」で落としている条件である。
          指定なしにすると本家と同じ扱いになり、春夏秋冬のスキルが同時に発動する。
        */}
        <Field label="季節">
          <select
            className={fieldCls}
            value={track.season ?? 0}
            onChange={(e) => setTrack({ season: Number(e.target.value) || undefined })}
          >
            <option value={0}>指定なし（本家と同じ）</option>
            <option value={1}>春</option>
            <option value={2}>夏</option>
            <option value={3}>秋</option>
            <option value={4}>冬</option>
          </select>
        </Field>
        <Field label="天候">
          <select
            className={fieldCls}
            value={track.weather ?? 0}
            onChange={(e) => setTrack({ weather: Number(e.target.value) || undefined })}
          >
            <option value={0}>指定なし（本家と同じ）</option>
            <option value={1}>晴</option>
            <option value={2}>曇</option>
            <option value={3}>雨</option>
            <option value={4}>雪</option>
          </select>
        </Field>
        <Field label="時刻">
          {/* スキルデータが区別しているのはナイターだけである。 */}
          <select
            className={fieldCls}
            value={track.time ?? 0}
            onChange={(e) => setTrack({ time: Number(e.target.value) || undefined })}
          >
            <option value={0}>指定なし（本家と同じ）</option>
            <option value={1}>昼</option>
            <option value={4}>ナイター</option>
          </select>
        </Field>
      </div>
      {detail !== undefined && (
        <>
          <CourseShape detail={detail} />
          <p className="text-[11px] text-ink3">
            {detail.surface === 1 ? '芝' : 'ダート'} ・ 基準タイム{' '}
            <span className="num">
              {detail.finishTimeMin} から {detail.finishTimeMax}
            </span>{' '}
            秒
          </p>
        </>
      )}
    </Panel>
  );
}

const STYLES: Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];
const STYLE_LABEL: Record<string, string> = { NIGE: '逃げ', SEN: '先行', SASI: '差し', OI: '追込' };
const CONDITIONS: Condition[] = ['BEST', 'GOOD', 'NORMAL', 'BAD', 'WORST'];
const CONDITION_LABEL: Record<Condition, string> = {
  BEST: '絶好調',
  GOOD: '好調',
  NORMAL: '普通',
  BAD: '不調',
  WORST: '絶不調',
};

export function UmaInput() {
  const uma = useStore((s) => s.uma);
  const setUma = useStore((s) => s.setUma);
  const track = useStore((s) => s.track);
  const skillIds = useStore((s) => s.skillIds);
  const options = useStore((s) => s.options);
  const debuffCounts = useStore((s) => s.debuffCounts);
  const modified = useMemo(
    () => modifiedStatus({ uma, track, skillIds, options, debuffCounts }),
    [uma, track, skillIds, options, debuffCounts],
  );

  // 入力した値がそのまま使われるわけではないので、補正後の値を下に添える。
  // 中身はやる気、コースの得意ステータス（courseSetStatus）、バ場、脚質適性など。
  // どれが効いたかまでは出さない。ここで見たいのは「入力と違う」ことである。
  const stat = (key: 'speed' | 'stamina' | 'power' | 'guts' | 'wisdom', label: string) => (
    <div className="flex flex-col gap-1">
      <Field label={label}>
        <input
          type="number"
          className={`${fieldCls} num text-right`}
          value={uma[key]}
          min={1}
          max={2500}
          onChange={(e) => setUma({ [key]: Number(e.target.value) })}
        />
      </Field>
      <span
        className="num text-right text-[11px] text-ink3"
        title="やる気やコースの得意ステータスなどの補正を当てた値。計算にはこちらが使われる"
      >
        → {modified[key]}
      </span>
    </div>
  );

  const fit = (key: 'distanceFit' | 'surfaceFit' | 'styleFit', label: string) => (
    <Field label={label}>
      <select
        className={fieldCls}
        value={uma[key]}
        onChange={(e) => setUma({ [key]: e.target.value as FitRank })}
      >
        {FIT_RANKS.map((rank) => (
          <option key={rank} value={rank}>
            {rank}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <Panel title="ウマ娘" variant="plain">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {stat('speed', 'スピード')}
        {stat('stamina', 'スタミナ')}
        {stat('power', 'パワー')}
        {stat('guts', '根性')}
        {stat('wisdom', '賢さ')}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Segmented
          label="脚質"
          value={uma.style}
          options={STYLES.map((style) => ({ value: style, label: STYLE_LABEL[style] ?? style }))}
          onChange={(style) => setUma({ style })}
        />
        <Segmented
          label="やる気"
          value={uma.condition}
          options={CONDITIONS.map((condition) => ({
            value: condition,
            label: CONDITION_LABEL[condition],
          }))}
          onChange={(condition) => setUma({ condition })}
        />
        <Field label="枠番（0 でランダム）">
          <input
            type="number"
            className={fieldCls}
            value={uma.gateNumber}
            min={0}
            max={18}
            onChange={(e) => setUma({ gateNumber: Number(e.target.value) })}
          />
        </Field>
        {fit('distanceFit', '距離適性')}
        {fit('surfaceFit', 'バ場適性')}
        {fit('styleFit', '脚質適性')}
      </div>
    </Panel>
  );
}

/** 固有と進化の札。押すと持つかどうかが変わる。 */
function SkillChip({
  skill,
  selected,
  onToggle,
}: {
  skill: SkillData;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={`rounded-sm border px-2 py-1 text-sm ${
        selected ? 'border-acc-ink bg-acc-tint text-acc-ink' : 'border-rule2 text-ink2'
      }`}
    >
      {selected ? '✓ ' : ''}
      {skill.name}
    </button>
  );
}

/**
 * キャラと、そのキャラの固有・進化。
 *
 * 本家は固有と進化を一覧に出さず、キャラを選んでから取らせる。
 * 誰の固有なのかが画面に出ないと、別のキャラの固有を混ぜても気付けない。
 * 固有レベルもここに置く。固有を持っていないときは効かないので、そのときは
 * 触れないようにしてある。
 */
function UniqueSkillInput() {
  const charaName = useStore((s) => s.uma.charaName);
  const uniqueLevel = useStore((s) => s.uma.uniqueLevel);
  const setUma = useStore((s) => s.setUma);
  const setCharaName = useStore((s) => s.setCharaName);
  const skillIds = useStore((s) => s.skillIds);
  const toggleSkill = useStore((s) => s.toggleSkill);

  const uniques = skillIndex.uniquesOf(charaName);
  const evos = skillIndex.evosOf(charaName);
  const hasUnique = uniques.some((skill) => skillIds.includes(skill.id));

  return (
    <div className="rounded-sm border border-rule p-2">
      <Field label="キャラ（固有と進化）">
        <select
          className={fieldCls}
          value={charaName}
          onChange={(e) => setCharaName(e.target.value)}
        >
          <option value={NO_CHARA}>未選択</option>
          {skillIndex.charas.map((chara) => (
            <option key={chara} value={chara}>
              {chara}
            </option>
          ))}
        </select>
      </Field>
      {charaName !== NO_CHARA && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {uniques.map((skill) => (
            <SkillChip
              key={skill.id}
              skill={skill}
              selected={skillIds.includes(skill.id)}
              onToggle={() => toggleSkill(skill.id)}
            />
          ))}
          <label className="ml-1 flex items-center gap-1 text-xs text-ink3">
            固有Lv
            <select
              className="rounded-sm border border-rule2 bg-surface px-1 py-0.5 text-xs disabled:text-ink3"
              value={uniqueLevel}
              disabled={!hasUnique}
              onChange={(e) => setUma({ uniqueLevel: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6].map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          {evos.map((skill) => (
            <SkillChip
              key={skill.id}
              skill={skill}
              selected={skillIds.includes(skill.id)}
              onToggle={() => toggleSkill(skill.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SkillInput() {
  const skillIds = useStore((s) => s.skillIds);
  const toggleSkill = useStore((s) => s.toggleSkill);
  const clearSkills = useStore((s) => s.clearSkills);
  const hintLevels = useStore((s) => s.hintLevels);
  const setHintLevel = useStore((s) => s.setHintLevel);
  const [query, setQuery] = useState('');
  const costModel = useMemo(() => costModelFor(hintLevels), [hintLevels]);

  const matched = useMemo(() => {
    if (query.trim() === '') return [];
    return skillChoices.filter((skill) => skill.name.includes(query.trim())).slice(0, 40);
  }, [query]);

  const selected = skillIds.map((id) => gameData.skillsById.get(id)!).filter(Boolean);

  return (
    <Panel title={`スキル（${skillIds.length} 個）`} variant="plain">
      <UniqueSkillInput />
      <input
        className={`${fieldCls} mt-2`}
        placeholder="スキル名で検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {matched.length > 0 && (
        <ul className="mt-2 max-h-48 overflow-y-auto rounded-sm border border-rule text-sm">
          {matched.map((skill) => (
            <li key={skill.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between px-2 py-1 text-left hover:bg-sunken"
                onClick={() => toggleSkill(skill.id)}
              >
                <span>{skill.name}</span>
                <span className="text-xs text-ink3">
                  {skillIds.includes(skill.id) ? '選択中' : skill.rarity}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected.length > 0 && (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm" data-testid="held-skills">
              <thead>
                <tr className="border-b border-rule text-xs text-ink3">
                  <th scope="col" className="py-1 text-left font-normal">スキル</th>
                  <th scope="col" className="py-1 text-right font-normal">ヒント</th>
                  <th scope="col" className="py-1 text-right font-normal">必要 pt</th>
                  <th scope="col" className="py-1 text-right font-normal">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {selected.map((skill) => (
                  <tr
                    key={skill.id}
                    className="border-b border-rule last:border-0"
                  >
                    <th scope="row" className="py-1 text-left font-normal">
                      {skill.name}
                      {skill.holder !== null && (
                        <span className="ml-1 text-[11px] text-ink3">
                          {skill.rarity === 'unique' ? '固有' : '進化'}
                        </span>
                      )}
                    </th>
                    <td className="py-1 text-right">
                      {/* 固有はスキルポイントで取るものではないので、ヒントも効かない。 */}
                      {skill.rarity === 'unique' ? (
                        <span className="text-xs text-ink3">—</span>
                      ) : (
                        <select
                          className="rounded-sm border border-rule2 bg-surface px-1 py-0.5 text-xs"
                          value={hintLevels[skill.id] ?? 0}
                          aria-label={`${skill.name} のヒントレベル`}
                          onChange={(e) => setHintLevel(skill.id, Number(e.target.value))}
                        >
                          {[0, 1, 2, 3, 4, 5].map((level) => (
                            <option key={level} value={level}>
                              Lv{level}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="py-1 text-right tabular-nums">{costModel.cost(skill.id)}</td>
                    <td className="py-1 text-right">
                      <button
                        type="button"
                        className="px-1 text-ink3 hover:text-ink2"
                        onClick={() => toggleSkill(skill.id)}
                        aria-label={`${skill.name} を外す`}
                        title="外す"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-ink3">
            <span>
              合計 {costModel.totalCost(selected.map((s) => s.id))} pt
              <span className="ml-2">同じグループからは上位のぶんだけ数える。</span>
            </span>
            <button type="button" className="underline" onClick={clearSkills}>
              すべて外す
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

const ADJUSTMENT_LABEL: Record<SkillActivateAdjustment, string> = {
  NONE: '抽選どおり',
  YES: 'スキルは必ず発動',
  ALL: 'スキルも他の乱数も固定',
};

const RANDOM_LABEL: Record<RandomPosition, string> = {
  RANDOM: '毎回引く',
  FASTEST: '最良（区間の先頭）',
  FAST: 'やや良（1/4 地点）',
  MIDDLE: '中間',
  SLOW: 'やや悪（3/4 地点）',
  SLOWEST: '最悪（区間の末尾）',
};

/** ポジションキープ。VIRTUAL は仮想先頭馬の入力口が無いので出さない。 */
const KEEP_LABEL: Record<Exclude<PositionKeepMode, 'VIRTUAL'>, string> = {
  APPROXIMATE: '近似（本家の既定）',
  SPEED_UP: '速度上げのみ抽選',
  NONE: '無効',
};

export function OptionsInput() {
  const options = useStore((s) => s.options);
  const setOptions = useStore((s) => s.setOptions);
  const debuffCounts = useStore((s) => s.debuffCounts);
  const setDebuffCount = useStore((s) => s.setDebuffCount);

  const debuffTotal = Object.values(debuffCounts).reduce((a, b) => a + b, 0);

  return (
    <Panel title="実行オプション" variant="plain">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="スキル発動率">
          <select
            className={fieldCls}
            value={options.skillActivateAdjustment}
            onChange={(e) =>
              setOptions({ skillActivateAdjustment: e.target.value as SkillActivateAdjustment })
            }
          >
            {(Object.keys(ADJUSTMENT_LABEL) as SkillActivateAdjustment[]).map((key) => (
              <option key={key} value={key}>
                {ADJUSTMENT_LABEL[key]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="ランダム発動区間の引き">
          <select
            className={fieldCls}
            value={options.randomPosition}
            onChange={(e) => setOptions({ randomPosition: e.target.value as RandomPosition })}
          >
            {(Object.keys(RANDOM_LABEL) as RandomPosition[]).map((key) => (
              <option key={key} value={key}>
                {RANDOM_LABEL[key]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="ポジションキープ">
          <select
            className={fieldCls}
            value={options.positionKeepMode === 'VIRTUAL' ? 'APPROXIMATE' : options.positionKeepMode}
            onChange={(e) => setOptions({ positionKeepMode: e.target.value as PositionKeepMode })}
          >
            {(Object.keys(KEEP_LABEL) as (keyof typeof KEEP_LABEL)[]).map((key) => (
              <option key={key} value={key}>
                {KEEP_LABEL[key]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="ポジションキープの発生率 (%)">
          <input
            type="number"
            className={fieldCls}
            value={options.positionKeepRate}
            min={0}
            max={100}
            disabled={options.positionKeepMode !== 'SPEED_UP'}
            onChange={(e) => setOptions({ positionKeepRate: Number(e.target.value) })}
          />
        </Field>
      </div>
      <p className="mt-2 text-xs text-ink3">
        発生率は「速度上げのみ抽選」のときだけ効く。「スキルも他の乱数も固定」を選ぶと、掛かりと
        下り坂とスパート候補の抽選も固定され、レースがほぼ決定的になる。
      </p>

      <h3 className="mt-4 mb-2 text-sm font-semibold">
        受けるデバフ
        <span className="ml-2 text-xs font-normal text-ink3">
          合計 {debuffTotal} 個
        </span>
      </h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {debuffTypes.map((type) => (
          <label key={type.id} className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate" title={type.label}>
              {type.label}
            </span>
            <input
              type="number"
              className="w-14 rounded-sm border border-rule2 bg-surface px-1 py-0.5 text-right text-xs tabular-nums"
              value={debuffCounts[type.id] ?? 0}
              min={0}
              max={12}
              onChange={(e) => setDebuffCount(type.id, Number(e.target.value))}
            />
          </label>
        ))}
      </div>
    </Panel>
  );
}

/**
 * 順位条件を判定するときの相手の想定。
 *
 * 相手の強さは順位条件つきスキルの評価をそのまま左右する入力である。
 * 既定を自分から独立に固定しておくと、強い自分は最初から最後まで先頭に
 * いることになり、後方寄りの条件が全部 0 % になる。
 * docs/order-field.md 2.1 節と 4.3 節を参照。
 */
export function OpponentInput() {
  const field = useStore((s) => s.field);
  const setField = useStore((s) => s.setField);
  const useField = useStore((s) => s.useField);
  const gateCount = useStore((s) => s.track.gateCount);

  // 「自分と同じ」「−100」「+100」の 3 段。数値の直接入力も残す。
  const levels: readonly { readonly label: string; readonly offset: number }[] = [
    { label: '自分と同じ', offset: 0 },
    { label: '−100', offset: -100 },
    { label: '+100', offset: 100 },
  ];

  return (
    <Panel title="相手の想定" variant="plain">
      {!useField && (
        <p className="text-xs text-ink3">
          順位条件を判定していないので、ここの設定は結果に効かない。実行バーの
          「順位条件を判定する」を入れると効く。
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="相手の強さ">
          <select
            className={fieldCls}
            value={field.matchSelf ? String(field.offset) : 'fixed'}
            onChange={(e) => {
              const value = e.target.value;
              if (value === 'fixed') setField({ matchSelf: false, offset: 0 });
              else setField({ matchSelf: true, offset: Number(value) });
            }}
          >
            {levels.map((level) => (
              <option key={level.offset} value={String(level.offset)}>
                {level.label}
              </option>
            ))}
            <option value="fixed">固定（1100-900-900-600-900）</option>
          </select>
        </Field>
        <Field label="ばらつき（標準偏差）">
          <input
            type="number"
            className={fieldCls}
            value={field.sigma}
            min={0}
            max={400}
            step={10}
            onChange={(e) => setField({ sigma: Math.max(0, Number(e.target.value)) })}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        <label className="flex items-center gap-1.5 text-xs text-ink2">
          <input
            type="checkbox"
            checked={field.redrawComposition}
            onChange={(e) => setField({ redrawComposition: e.target.checked })}
          />
          脚質構成を引き直す
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink2">
          <input
            type="checkbox"
            checked={field.withSkills}
            onChange={(e) => setField({ withSkills: e.target.checked })}
          />
          相手にスキルを持たせる
        </label>
      </div>
      <p className="text-xs text-ink3">
        相手 {gateCount - 1} 頭を一緒に走らせて位置を記録し、その束に対して順位を判定する。
        引き直しを入れると、束の 1 本ごとに脚質構成・強さ・やる気・スキルが変わる。
        相手を固定して引き直しを切ると、順位が塊の境目にしか出ず、3 位以内や 6 位以降の
        条件が 0 % になる。
      </p>
    </Panel>
  );
}

export function RunPanel() {
  const { count, seed, running, progress, setCount, setSeed, run, cancel, useField, setUseField } =
    useStore();
  const gateCount = useStore((s) => s.track.gateCount);
  const elapsedMs = useStore((s) => s.elapsedMs);
  const summary = useStore((s) => s.summary);
  // 押す前に、どれくらい待つのかを出す。20 万試行は条件次第で数分かかる。
  //
  // セレクタの中で組み立ててはいけない。毎回新しいオブジェクトが返り、
  // zustand が参照の違いを変化と見て描画が止まらなくなる（React error #185）。
  const pace = useStore((s) => s.pace);
  const estimate = useMemo(() => estimateRun({ pace, useField, count }), [pace, useField, count]);
  const inputCls = 'num rounded-sm border border-rule2 bg-surface px-2 py-1 text-right text-xs text-ink';
  return (
    <div className="flex flex-none flex-wrap items-center gap-3 border-b border-rule bg-surface px-5 py-2.5">
      <label className="flex items-center gap-2 text-xs text-ink3">
        試行回数
        <input
          type="number"
          className={`${inputCls} w-24`}
          value={count}
          min={1}
          max={200000}
          step={1000}
          onChange={(e) => setCount(Number(e.target.value))}
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-ink3">
        シード
        <input
          type="number"
          className={`${inputCls} w-20`}
          value={seed}
          onChange={(e) => setSeed(Number(e.target.value))}
        />
      </label>
      <button
        type="button"
        className="rounded-sm bg-primary-bg px-4 py-1.5 text-xs font-semibold text-primary-fg disabled:opacity-50"
        onClick={() => void run()}
        disabled={running}
        title="Ctrl+Enter（Mac は Cmd+Enter）でも実行できる"
      >
        {running ? '実行中' : '実行'}
      </button>
      {running ? (
        <>
          <button
            type="button"
            className="rounded-sm border border-rule2 px-3 py-1.5 text-xs"
            onClick={cancel}
            title="Esc でも中断できる"
          >
            中断
          </button>
          <span className="num text-xs text-ink3" role="status" aria-live="polite">
            {progress} / {count}
          </span>
        </>
      ) : (
        <span
          className="text-xs text-ink3"
          data-testid="run-estimate"
          title={
            estimate.measured
              ? '直前の実測から出している'
              : '作り付けの目安。1 回走らせると実測に置き換わる'
          }
        >
          {estimate.measured ? '見込み' : '目安'} 約 {formatDuration(estimate.ms)}
        </span>
      )}
      <label className="flex items-center gap-1.5 text-xs text-ink2">
        <input
          type="checkbox"
          data-testid="use-field"
          checked={useField}
          onChange={(e) => setUseField(e.target.checked)}
        />
        順位条件を判定する
        <span className="text-ink3">（相手 {gateCount - 1} 頭）</span>
      </label>
      <span className="ml-auto text-[11px] text-ink3">
        {summary !== null && <span className="num mr-3">前回 {(elapsedMs / 1000).toFixed(2)} 秒</span>}
        Ctrl+Enter で実行、Esc で中断
      </span>
    </div>
  );
}
