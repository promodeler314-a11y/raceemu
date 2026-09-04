import { useMemo, useState } from 'react';
import { FIT_RANKS, type Condition, type FitRank, type Style } from '../../../../packages/sim/src/data/constants.ts';
import { currentTrackDetail, gameData, skillChoices, useStore } from '../store.ts';

const labelCls = 'block text-xs text-neutral-500 dark:text-neutral-400';
const fieldCls =
  'w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  );
}

export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
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
    <Panel title="コース">
      <div className="grid grid-cols-2 gap-3">
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
        <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
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
    <Panel title="ウマ娘">
      <div className="grid grid-cols-5 gap-2">
        {stat('speed', 'スピード')}
        {stat('stamina', 'スタミナ')}
        {stat('power', 'パワー')}
        {stat('guts', '根性')}
        {stat('wisdom', '賢さ')}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Field label="脚質">
          <select
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
  const [query, setQuery] = useState('');

  const matched = useMemo(() => {
    if (query.trim() === '') return [];
    return skillChoices.filter((c) => c.name.includes(query.trim())).slice(0, 40);
  }, [query]);

  const selected = skillIds.map((id) => gameData.skillsById.get(id)!).filter(Boolean);

  return (
    <Panel title={`スキル（${skillIds.length} 個）`}>
      <input
        className={fieldCls}
        placeholder="スキル名で検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {matched.length > 0 && (
        <ul className="mt-2 max-h-48 overflow-y-auto rounded border border-neutral-200 text-sm dark:border-neutral-800">
          {matched.map(({ name, skill }) => (
            <li key={skill.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between px-2 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                onClick={() => toggleSkill(skill.id)}
              >
                <span>{name}</span>
                <span className="text-xs text-neutral-500">
                  {skillIds.includes(skill.id) ? '選択中' : skill.rarity}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {selected.map((skill) => (
            <button
              key={skill.id}
              type="button"
              className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              onClick={() => toggleSkill(skill.id)}
              title="クリックで外す"
            >
              {skill.name} ×
            </button>
          ))}
          <button
            type="button"
            className="rounded-full px-2 py-0.5 text-xs text-neutral-500 underline"
            onClick={clearSkills}
          >
            すべて外す
          </button>
        </div>
      )}
    </Panel>
  );
}

export function RunPanel() {
  const { count, seed, running, progress, setCount, setSeed, run, cancel, error } = useStore();
  return (
    <Panel title="実行">
      <div className="grid grid-cols-2 gap-3">
        <Field label="試行回数">
          <input
            type="number"
            className={fieldCls}
            value={count}
            min={1}
            max={200000}
            step={1000}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </Field>
        <Field label="シード">
          <input
            type="number"
            className={fieldCls}
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value))}
          />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          className="rounded bg-neutral-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          onClick={() => void run()}
          disabled={running}
        >
          {running ? '実行中' : '実行'}
        </button>
        {running && (
          <>
            <button
              type="button"
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
              onClick={cancel}
            >
              中断
            </button>
            <span className="text-sm text-neutral-500">
              {progress} / {count}
            </span>
          </>
        )}
      </div>
      {error !== null && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </Panel>
  );
}
