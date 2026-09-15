import { Fragment, useEffect, useMemo, useState } from 'react';
import { styleLabel, type Style } from '../../../../packages/sim/src/data/constants.ts';
import { FIDELITY_MARK } from '../../../../packages/sim/src/skill/classify.ts';
import type {
  SkillListCategory,
  SkillListFile,
} from '../../../../packages/solver/src/skill-list.ts';
import {
  DEFAULT_SKILL_LIST_FILTER,
  FIXED_AXES,
  aggregate,
  baselineTiers,
  courseBreakdown,
  explainSkillListError,
  fetchSkillList,
  upgradeGroups,
  type SkillListAggregate,
  type SkillListFilter,
  type SkillListGroup,
} from '../skillList.ts';
import { gameData, useStore } from '../store.ts';
import { PlainFidelityMark } from './Fidelity.tsx';
import { Panel } from './Inputs.tsx';

/**
 * スキル一覧の面（[#83](https://github.com/promodeler314-a11y/raceemu/issues/83)）。
 *
 * 全スキル × 全コースの**単体評価を事前に計算した表**を読んで並べる。
 * ここでは 1 レースも走らせない。走らせる版は探索の面の「単体で足したときの効き」で、
 * あちらはいまの設定に縛られたその場の計算である。
 *
 * 置き場と絞り込みの軸、バ身の扱い、取れなかったときの振る舞いは
 * docs/webapp-design.md 6.6 節に書いた。
 */

const CATEGORY_LABEL: Readonly<Record<SkillListCategory, string>> = {
  SHORT: '短距離',
  MILE: 'マイル',
  MIDDLE: '中距離',
  LONG: '長距離',
};

const TRACK_CONDITION_LABEL: Readonly<Record<number, string>> = {
  1: '良',
  2: '稍重',
  3: '重',
  4: '不良',
};

/** 一度に出す行数。全スキルを一度に描くと、絞り込みのたびに固まる。 */
const PAGE = 50;

const selectCls = 'rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm';

const nameOf = (id: string) => gameData.skillsById.get(id)?.name ?? id;
const seconds = (value: number) => `${value >= 0 ? '' : '-'}${Math.abs(value).toFixed(3)}`;
const percent = (value: number) => `${(value * 100).toFixed(1)} %`;

/**
 * 表の取得は 1 回でよい。面を開き直すたびに数 MB を取り直さない。
 *
 * 中身は版が変わらないかぎり変わらないので、読み込んだものを持っておく。
 * 失敗も覚える。置いていない配布物で、面を開くたびに取りに行っても
 * 結果は変わらない。
 */
let cached: Promise<SkillListFile> | null = null;
function loadSkillList(): Promise<SkillListFile> {
  cached ??= fetchSkillList();
  return cached;
}

/** テストと `pnpm e2e` から握り直せるようにする。画面からは呼ばない。 */
export function resetSkillListCache(): void {
  cached = null;
}

export function SkillListPanel() {
  const [file, setFile] = useState<SkillListFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadSkillList().then(
      (loaded) => {
        if (alive) setFile(loaded);
      },
      (reason: unknown) => {
        if (alive) setError(explainSkillListError(reason));
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  if (error !== null) {
    return (
      <Panel title="スキル一覧">
        <p
          className="rounded-sm border border-warn-rule bg-warn-tint px-3 py-2 text-xs text-warn-ink"
          data-testid="skill-list-error"
          role="status"
        >
          {error}
        </p>
        <p className="mt-2 text-xs text-ink3">
          他の面はこの表に依っていないので、そのまま使える。いまの設定でのスキルの効きは、
          探索の面の「単体で足したときの効き」が実際に走らせて出す。
        </p>
      </Panel>
    );
  }
  if (file === null) {
    return (
      <Panel title="スキル一覧">
        <p className="text-xs text-ink3" data-testid="skill-list-loading">
          事前に計算した表を読み込んでいる。数 MB あるので少しかかる。
        </p>
      </Panel>
    );
  }
  return <SkillListTable file={file} />;
}

function SkillListTable({ file }: { file: SkillListFile }) {
  // 基準個体は「段」で選ぶ。個体 1 つに固定すると、その個体が割り当てられた
  // 距離帯とバ場の行しか当たらない（skillList.ts の matcher の注記）。
  const tiers = useMemo(() => baselineTiers(file), [file]);
  const [filter, setFilter] = useState<SkillListFilter>({
    ...DEFAULT_SKILL_LIST_FILTER,
    baseline: tiers[0]?.id ?? '',
  });
  const [query, setQuery] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [opened, setOpened] = useState<string | null>(null);

  const skillIds = useStore((s) => s.skillIds);
  const toggleSkill = useStore((s) => s.toggleSkill);
  const setTab = useStore((s) => s.setTab);

  // セレクタの中で組み立てない。組み立てはここで行う（CLAUDE.md の apps/web の節）。
  const held = useMemo(() => new Set(skillIds), [skillIds]);
  const rows = useMemo(() => aggregate(file, filter), [file, filter]);
  const shown = useMemo(() => {
    const needle = query.trim();
    return rows.filter((row) => {
      if (onlyMissing && held.has(row.skillId)) return false;
      if (needle === '') return true;
      return nameOf(row.skillId).includes(needle);
    });
  }, [rows, query, onlyMissing, held]);
  const recommended = useMemo(
    () =>
      rows
        .filter((row) => !held.has(row.skillId) && row.cost > 0 && row.mean > 0)
        .sort((a, b) => b.efficiency - a.efficiency)
        .slice(0, 5),
    [rows, held],
  );
  const groups = useMemo(
    () => upgradeGroups(shown, (id) => gameData.skillsById.get(id)?.group ?? -1).slice(0, 8),
    [shown],
  );

  const categories = useMemo(
    () => [...new Set(file.courses.map((course) => course.category))],
    [file],
  );
  const surfaces = useMemo(() => [...new Set(file.courses.map((c) => c.surface))], [file]);

  // 絞り込みを変えたら先頭から見せ直す。開いた行も閉じる。
  const update = (patch: Partial<SkillListFilter>) => {
    setFilter((current) => ({ ...current, ...patch }));
    setLimit(PAGE);
    setOpened(null);
  };

  const addAndSolve = (skillId: string) => {
    if (!held.has(skillId)) toggleSkill(skillId);
    setTab('solve');
  };

  return (
    <Panel title="スキル一覧">
      <p className="text-xs text-ink3">
        全スキルを、決めておいた基準の個体で、コースと脚質ごとに 1 つずつ足して測った表である。
        ここでは走らせない。事前に計算したものを読んでいるだけなので、いまの設定は効かない。
      </p>
      <p className="mt-1 rounded-sm border border-rule bg-sunken px-3 py-2 text-xs text-ink2">
        <strong>「単体」であって「限界」ではない。</strong>
        何も持っていない構成へ 1 つだけ足したときの差なので、食い合うスキル
        （最終直線の加速どうしなど）は過大に出る。既に何か持っている状態での効きは、
        探索の面の「限界」の列が出す。
      </p>

      <Provenance file={file} />

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-xs text-ink3">距離帯</span>
          <select
            className={selectCls}
            value={filter.category}
            aria-label="距離帯"
            data-testid="skill-list-category"
            onChange={(e) => update({ category: e.target.value as SkillListCategory | 'ALL' })}
          >
            <option value="ALL">すべて</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABEL[category]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs text-ink3">脚質</span>
          <select
            className={selectCls}
            value={filter.style}
            aria-label="脚質（スキル一覧）"
            data-testid="skill-list-style"
            onChange={(e) => update({ style: e.target.value as Style | 'ALL' })}
          >
            <option value="ALL">すべて</option>
            {file.styles.map((style) => (
              <option key={style} value={style}>
                {styleLabel[style]}
              </option>
            ))}
          </select>
        </label>
        {surfaces.length > 1 && (
          <label className="block">
            <span className="block text-xs text-ink3">バ場</span>
            <select
              className={selectCls}
              value={filter.surface}
              aria-label="バ場（スキル一覧）"
              data-testid="skill-list-surface"
              onChange={(e) => update({ surface: Number(e.target.value) as 0 | 1 | 2 })}
            >
              <option value={0}>すべて</option>
              <option value={1}>芝</option>
              <option value={2}>ダート</option>
            </select>
          </label>
        )}
        {tiers.length > 1 && (
          <label className="block">
            <span className="block text-xs text-ink3">基準の個体</span>
            <select
              className={selectCls}
              value={filter.baseline}
              aria-label="基準の個体"
              data-testid="skill-list-baseline"
              onChange={(e) => update({ baseline: e.target.value })}
            >
              {tiers.map((tier) => (
                <option key={tier.id} value={tier.id}>
                  {tier.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="block text-xs text-ink3">スキル名</span>
          <input
            className={selectCls}
            value={query}
            placeholder="スキル名で絞る"
            aria-label="スキル名で絞る"
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
          />
        </label>
        <label className="flex items-center gap-2 pb-1 text-xs">
          <input
            type="checkbox"
            checked={onlyMissing}
            data-testid="skill-list-only-missing"
            onChange={(e) => {
              setOnlyMissing(e.target.checked);
              setLimit(PAGE);
            }}
          />
          持っていないものだけ
        </label>
      </div>

      <p className="mt-2 text-xs text-ink3">
        基準の個体は<strong>段だけを選ぶ</strong>。中身（とくにスタミナ）は距離帯とバ場で
        変えてあり、どれが使われるかはコースから決まるためである（この版は{' '}
        {file.baselines.length} 個体を {tiers.length} 段に分けて持っている）。
        {FIXED_AXES.join('、')}の選択欄は出していない。この版が 1 通りしか測っておらず、
        選べても何も変わらないからである（バ場状態は
        {TRACK_CONDITION_LABEL[file.settings.trackCondition] ?? `不明（${file.settings.trackCondition}）`}
        で固定）。測る軸が増えれば選択欄も増える。
      </p>

      {recommended.length > 0 && (
        <Recommend rows={recommended} onPick={addAndSolve} />
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-xs" data-testid="skill-list-table">
          <thead className="text-ink3">
            <tr>
              <th scope="col" className="pb-1 pr-2 text-left font-normal">
                スキル
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                短縮（秒）
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                バ身
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                発動率
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                発動時（秒）
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                pt
              </th>
              <th scope="col" className="pb-1 text-right font-normal">
                ミリ秒/pt
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((row) => (
              <Fragment key={row.skillId}>
                <tr className="border-b border-rule last:border-0">
                  <th scope="row" className="py-1 pr-2 text-left font-normal">
                    <button
                      type="button"
                      className="text-left underline decoration-rule2 underline-offset-2"
                      aria-label={`${nameOf(row.skillId)} のコースごとの内訳`}
                      onClick={() =>
                        setOpened((current) => (current === row.skillId ? null : row.skillId))
                      }
                    >
                      {nameOf(row.skillId)}
                    </button>
                    <PlainFidelityMark fidelity={row.fidelity} />
                    {held.has(row.skillId) && (
                      <span className="ml-1 text-acc-ink" title="設定の面で選んでいる">
                        ✓
                      </span>
                    )}
                  </th>
                  <td className="num py-1 pr-2 text-right">
                    {seconds(row.mean)}
                    <span className="text-ink3"> ± {(2 * row.stdError).toFixed(3)}</span>
                  </td>
                  <td className="num py-1 pr-2 text-right text-ink3">{row.bashin.toFixed(2)}</td>
                  <td className="num py-1 pr-2 text-right">{percent(row.triggerRate)}</td>
                  <td className="num py-1 pr-2 text-right">{seconds(row.meanWhenTriggered)}</td>
                  <td className="num py-1 pr-2 text-right">{row.cost}</td>
                  <td className="num py-1 text-right">{(1000 * row.efficiency).toFixed(3)}</td>
                </tr>
                {opened === row.skillId && (
                  <tr>
                    <td colSpan={7} className="bg-sunken px-2 py-2">
                      <Breakdown file={file} filter={filter} row={row} onPick={addAndSolve} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink3">
        <span data-testid="skill-list-count">
          {shown.length.toLocaleString('ja-JP')} 件中 {Math.min(limit, shown.length)} 件
        </span>
        {limit < shown.length && (
          <button
            type="button"
            className="rounded-sm border border-rule2 px-2 py-1"
            onClick={() => setLimit((current) => current + PAGE * 2)}
          >
            もっと出す
          </button>
        )}
      </div>

      <p className="mt-2 text-xs text-ink3">
        <span className="text-ink3">{FIDELITY_MARK.approximate}</span>{' '}
        発動条件の一部を確率で近似している、または作り物の相手に対して判定している。{' '}
        <span className="text-warn-ink">{FIDELITY_MARK.dropped}</span>{' '}
        発動条件の一部を落としている。落とした条件は満たしている扱いになるので、発動率も短縮量も
        本来より高く出る。印は絞り込みに当たる行のうち、いちばん悪いものである。
      </p>
      <p className="mt-1 text-xs text-ink3">
        <strong>バ身は目安である。</strong>1 バ身 = 2.5 m はゲームからの裏取り前であり
        （<a
          className="underline"
          href="https://github.com/promodeler314-a11y/raceemu/issues/52"
          target="_blank"
          rel="noreferrer noopener"
        >
          #52
        </a>
        ）、1 秒が何メートルかも走っている速度に依る。ここではコースの基準速度
        （2000 m で 20.0 m/s）で置いているので、終盤の速い区間で稼いだぶんは小さめに出る。
        <strong>秒のほうを見ること。</strong>
      </p>
      <p className="mt-1 text-xs text-ink3">
        <strong>行が無いことには 2 通りある。</strong>走らせる前に落とした組（この条件では
        確かに発動しない）が {file.screenedOut.toLocaleString('ja-JP')} 件あり、それとは別に、
        この版がそもそも測っていない組がある。表に出ているのは測った組だけである。
      </p>

      {groups.length > 0 && <UpgradeGroups groups={groups} />}
    </Panel>
  );
}

/** どの版の、何から作った表かを出す。値は相手の分布に依るので、版は隠さない。 */
function Provenance({ file }: { file: SkillListFile }) {
  return (
    <div
      className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink3"
      data-testid="skill-list-version"
    >
      <span className="num">版 {file.version}</span>
      <span className="num">
        {file.skillIds.length.toLocaleString('ja-JP')} スキル ・ {file.courses.length} コース ・{' '}
        {file.columns.length.toLocaleString('ja-JP')} 行
      </span>
      <span className="num">{file.settings.trials.toLocaleString('ja-JP')} 試行 / 行</span>
      <span>{file.settings.useField ? '順位条件を判定した' : '順位条件は満たしている前提'}</span>
      <span className="num" title="スキル / コース / 計算式 / 相手の分布 の指紋">
        指紋 {file.dataset.skills}・{file.dataset.courses}・{file.dataset.raceModel}・
        {file.dataset.fieldProfile}
      </span>
      <span className="num">{file.generatedAt.slice(0, 10)}</span>
    </div>
  );
}

/** 持っていないスキルのうち、効率の高いものを勧める。探索の面への入口でもある。 */
function Recommend({
  rows,
  onPick,
}: {
  rows: readonly SkillListAggregate[];
  onPick: (skillId: string) => void;
}) {
  return (
    <div className="mt-3 rounded-sm border border-rule bg-surface p-3" data-testid="skill-list-recommend">
      <h3 className="text-xs font-semibold">持っていないもののうち、効率の高い順</h3>
      <p className="mt-1 text-xs text-ink3">
        この絞り込みでの 1 ポイントあたりの短縮量が大きい順である。単体の評価なので、
        <strong>まとめて取ると足し算にはならない</strong>。組み合わせは探索の面で決める。
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {rows.map((row) => (
          <button
            key={row.skillId}
            type="button"
            className="rounded-full border border-rule2 px-2 py-0.5 text-xs hover:bg-sunken"
            aria-label={`${nameOf(row.skillId)} を所持に加えて探索の面へ`}
            onClick={() => onPick(row.skillId)}
          >
            {nameOf(row.skillId)}
            <PlainFidelityMark fidelity={row.fidelity} />{' '}
            <span className="num text-ink3">
              {seconds(row.mean)} 秒 / {row.cost} pt
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 1 スキルのコースごとの内訳。行を押すとここに降りる。 */
function Breakdown({
  file,
  filter,
  row,
  onPick,
}: {
  file: SkillListFile;
  filter: SkillListFilter;
  row: SkillListAggregate;
  onPick: (skillId: string) => void;
}) {
  const courses = useMemo(
    () => courseBreakdown(file, filter, row.skillId),
    [file, filter, row.skillId],
  );
  return (
    <div data-testid="skill-list-breakdown">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">
          {nameOf(row.skillId)} ・ コースごとの内訳（{courses.length} コース ・ 平均に入った行{' '}
          {row.rows}）
        </span>
        <button
          type="button"
          className="rounded-sm border border-rule2 px-2 py-0.5 text-xs"
          aria-label={`${nameOf(row.skillId)} を所持に加えて探索の面へ`}
          onClick={() => onPick(row.skillId)}
        >
          所持に加えて探索へ
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[24rem] text-xs">
          <thead className="text-ink3">
            <tr>
              <th scope="col" className="pb-1 pr-2 text-left font-normal">
                コース
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                短縮（秒）
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                バ身
              </th>
              <th scope="col" className="pb-1 text-right font-normal">
                発動率
              </th>
            </tr>
          </thead>
          <tbody>
            {courses.map((course) => (
              <tr key={course.course.course} className="border-b border-rule last:border-0">
                <th scope="row" className="py-1 pr-2 text-left font-normal">
                  {course.course.locationName} {course.course.courseName}
                </th>
                <td className="num py-1 pr-2 text-right">
                  {seconds(course.mean)}
                  <span className="text-ink3"> ± {(2 * course.stdError).toFixed(3)}</span>
                </td>
                <td className="num py-1 pr-2 text-right text-ink3">{course.bashin.toFixed(2)}</td>
                <td className="num py-1 text-right">{percent(course.triggerRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-ink3">
        <strong>発動位置の分布はここには出せない。</strong>
        配っている JSON が持っているのはコースごとの平均までで、位置は入っていない。
        いまの設定での発動位置は、結果の面と詳細の面が実際に走らせて出す。
      </p>
    </div>
  );
}

/** 上位互換のグループ。差額と効果差で並べる。 */
function UpgradeGroups({ groups }: { groups: readonly SkillListGroup[] }) {
  return (
    <div className="mt-4">
      <h3 className="text-xs font-semibold">上位互換のグループ</h3>
      <p className="mt-1 text-xs text-ink3">
        表示されているポイントは<strong>そのスキルを持つまでの総額</strong>なので、
        上位への乗り換えは差額で見る。効果も同じで、
        乗り換えて何秒増えるのかは差で見ないと分からない。差額のわりに効果差が小さいものは、
        下位で止めるほうがよい。
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[26rem] text-xs" data-testid="skill-list-groups">
          <thead className="text-ink3">
            <tr>
              <th scope="col" className="pb-1 pr-2 text-left font-normal">
                スキル
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                差額（pt）
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                効果差（秒）
              </th>
              <th scope="col" className="pb-1 text-right font-normal">
                差額あたり（ミリ秒/pt）
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.group}>
                {group.members.map((member, i) => (
                  <tr key={member.row.skillId} className="border-b border-rule last:border-0">
                    <th scope="row" className="py-1 pr-2 text-left font-normal">
                      {i > 0 && <span className="text-ink3">→ </span>}
                      {nameOf(member.row.skillId)}
                      <PlainFidelityMark fidelity={member.row.fidelity} />
                    </th>
                    <td className="num py-1 pr-2 text-right">
                      {i === 0 ? member.costStep : `+${member.costStep}`}
                    </td>
                    <td className="num py-1 pr-2 text-right">
                      {i === 0 ? seconds(member.meanStep) : `${member.meanStep >= 0 ? '+' : ''}${seconds(member.meanStep)}`}
                    </td>
                    <td className="num py-1 text-right">
                      {member.costStep === 0
                        ? '—'
                        : ((1000 * member.meanStep) / member.costStep).toFixed(3)}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
