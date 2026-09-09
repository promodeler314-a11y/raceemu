import { useMemo, useState } from 'react';
import { FIT_RANKS, type Condition, type FitRank, type Style } from '../../../../packages/sim/src/data/constants.ts';
import {
  costModelFor,
  currentTrackDetail,
  debuffTypes,
  gameData,
  skillChoices,
  useStore,
} from '../store.ts';
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
        <Field label="バ場状態">
          <select
            className={fieldCls}
            value={track.condition}
            onChange={(e) => setTrack({ condition: Number(e.target.value) })}
          >
            <option value={1}>良</option>
            <option value={2}>稍重</option>
            <option value={3}>重</option>
            <option value={4}>不良</option>
          </select>
        </Field>
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
      </div>
      {detail !== undefined && (
        <p className="mt-3 text-xs text-ink3">
          {detail.distance} m / {detail.surface === 1 ? '芝' : 'ダート'} / コーナー{' '}
          {detail.corners.length} / 基準タイム {detail.finishTimeMin} から {detail.finishTimeMax} 秒
        </p>
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

  const stat = (key: 'speed' | 'stamina' | 'power' | 'guts' | 'wisdom', label: string) => (
    <Field label={label}>
      <input
        type="number"
        className={fieldCls}
        value={uma[key]}
        min={1}
        max={2500}
        onChange={(e) => setUma({ [key]: Number(e.target.value) })}
      />
    </Field>
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
        <Field label="脚質">
          <select
            data-testid="style"
            className={fieldCls}
            value={uma.style}
            onChange={(e) => setUma({ style: e.target.value as Style })}
          >
            {STYLES.map((style) => (
              <option key={style} value={style}>
                {STYLE_LABEL[style]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="やる気">
          <select
            className={fieldCls}
            value={uma.condition}
            onChange={(e) => setUma({ condition: e.target.value as Condition })}
          >
            {CONDITIONS.map((condition) => (
              <option key={condition} value={condition}>
                {CONDITION_LABEL[condition]}
              </option>
            ))}
          </select>
        </Field>
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
    return skillChoices.filter((c) => c.name.includes(query.trim())).slice(0, 40);
  }, [query]);

  const selected = skillIds.map((id) => gameData.skillsById.get(id)!).filter(Boolean);

  return (
    <Panel title={`スキル（${skillIds.length} 個）`} variant="plain">
      <input
        className={fieldCls}
        placeholder="スキル名で検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {matched.length > 0 && (
        <ul className="mt-2 max-h-48 overflow-y-auto rounded-sm border border-rule text-sm">
          {matched.map(({ name, skill }) => (
            <li key={skill.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between px-2 py-1 text-left hover:bg-sunken"
                onClick={() => toggleSkill(skill.id)}
              >
                <span>{name}</span>
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
            <table className="w-full text-sm">
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
                    </th>
                    <td className="py-1 text-right">
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

export function RunPanel() {
  const { count, seed, running, progress, setCount, setSeed, run, cancel, useField, setUseField } =
    useStore();
  const gateCount = useStore((s) => s.track.gateCount);
  const elapsedMs = useStore((s) => s.elapsedMs);
  const summary = useStore((s) => s.summary);
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
      {running && (
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
      )}
      <label className="flex items-center gap-1.5 text-xs text-ink2">
        <input type="checkbox" checked={useField} onChange={(e) => setUseField(e.target.checked)} />
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
