import { useState } from 'react';
import {
  FIDELITY_LABEL,
  FIDELITY_MARK,
  type Fidelity,
  type SkillFidelity,
} from '../../../../packages/sim/src/skill/classify.ts';

/**
 * スキルの発動条件をどこまで本当に判定しているかの印。
 *
 * 探索は、モデルが実際より高く評価している箇所を選び出す（docs/solver-design.md 4 節）。
 * 歪みを消すことはできないが、どのスキルがそこに乗っているかは示せる。
 * 分類は走らせずに条件式から決まるので、結果が出る前から同じ印になる。
 */

const MARK_CLASS: Readonly<Record<Fidelity, string>> = {
  exact: '',
  approximate: 'text-ink3',
  dropped: 'text-warn-ink',
};

function titleOf(fidelity: SkillFidelity): string {
  // 条件の型名（note.type）は内部の名前なので出さない。理由の文だけで読める
  return [
    FIDELITY_LABEL[fidelity.fidelity],
    ...fidelity.notes.map((note) => `${FIDELITY_MARK[note.fidelity]} ${note.reason}`),
  ].join('\n');
}

/**
 * 印 1 つ。完全に判定できているものには何も出さない。
 *
 * 理由をマウスを合わせたときの title だけに持たせると、タッチ端末では見られない
 * （#103、UI 診断 第3節 A-8）。押すと印の下に理由を開き、もう一度押すと閉じる。
 */
export function FidelityMark({ fidelity }: { fidelity: SkillFidelity | undefined }) {
  const [open, setOpen] = useState(false);
  if (fidelity === undefined || fidelity.fidelity === 'exact') return null;
  const text = titleOf(fidelity);
  return (
    <span className="relative ml-1 inline-block">
      <button
        type="button"
        className={MARK_CLASS[fidelity.fidelity]}
        title={text}
        aria-label={`${FIDELITY_LABEL[fidelity.fidelity]}（理由の表示）`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {FIDELITY_MARK[fidelity.fidelity]}
      </button>
      {open && (
        <span
          role="note"
          className="absolute left-0 top-full z-20 mt-1 block w-64 whitespace-pre-line rounded-sm border border-rule2 bg-surface p-2 text-left text-[11px] font-normal text-ink2"
        >
          {text}
        </span>
      )}
    </span>
  );
}

/**
 * 印だけを出す。理由の一覧を持たない場合に使う。
 *
 * 事前計算のスキル一覧（#83）は JSON に印そのものしか持っていない。
 * 理由は生成時の設定に対して決まったものなので、いまの設定から組み直すと
 * 表の値と食い違う。そこで印だけを出し、意味は凡例に任せる。
 */
export function PlainFidelityMark({ fidelity }: { fidelity: Fidelity }) {
  if (fidelity === 'exact') return null;
  return (
    <span
      className={`ml-1 ${MARK_CLASS[fidelity]}`}
      title={FIDELITY_LABEL[fidelity]}
      aria-label={FIDELITY_LABEL[fidelity]}
    >
      {FIDELITY_MARK[fidelity]}
    </span>
  );
}

/** スキル名と印。表の中で何度も使う。 */
export function SkillNameWithMark({
  name,
  fidelity,
}: {
  name: string;
  fidelity: SkillFidelity | undefined;
}) {
  return (
    <span className="whitespace-nowrap">
      {name}
      <FidelityMark fidelity={fidelity} />
    </span>
  );
}

/** 印の意味。表の外に 1 度だけ置く。 */
export function FidelityLegend({ useField }: { useField: boolean }) {
  return (
    <p className="text-xs text-ink3">
      <span className="text-ink3">{FIDELITY_MARK.approximate}</span>{' '}
      発動条件の一部を確率で近似している、または作り物の相手に対して判定しています。{' '}
      <span className="text-warn-ink">{FIDELITY_MARK.dropped}</span>{' '}
      発動条件の一部を落としています。落とした条件は満たしている扱いになるので、発動率も短縮量も本来より高く出ます。
      {!useField &&
        '順位条件を判定していないので、順位と距離差の条件はすべて落ちている側に入ります。'}
      {' 印を押すと、どの条件がそうなのかが出ます。'}
    </p>
  );
}

/** 構成の中に近似と切り落としがいくつあるか。 */
export function countFidelity(
  skillIds: readonly string[],
  fidelities: ReadonlyMap<string, SkillFidelity>,
): Readonly<Record<Fidelity, number>> {
  const counts: Record<Fidelity, number> = { exact: 0, approximate: 0, dropped: 0 };
  for (const id of skillIds) {
    const fidelity = fidelities.get(id);
    counts[fidelity?.fidelity ?? 'exact'] += 1;
  }
  return counts;
}
