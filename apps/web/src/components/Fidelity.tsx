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
  return [
    FIDELITY_LABEL[fidelity.fidelity],
    ...fidelity.notes.map((note) => `${FIDELITY_MARK[note.fidelity]} ${note.type}: ${note.reason}`),
  ].join('\n');
}

/** 印 1 つ。完全に判定できているものには何も出さない。 */
export function FidelityMark({ fidelity }: { fidelity: SkillFidelity | undefined }) {
  if (fidelity === undefined || fidelity.fidelity === 'exact') return null;
  return (
    <span
      className={`ml-1 ${MARK_CLASS[fidelity.fidelity]}`}
      title={titleOf(fidelity)}
      aria-label={FIDELITY_LABEL[fidelity.fidelity]}
    >
      {FIDELITY_MARK[fidelity.fidelity]}
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
      発動条件の一部を確率で近似している、または作り物の相手に対して判定している。{' '}
      <span className="text-warn-ink">{FIDELITY_MARK.dropped}</span>{' '}
      発動条件の一部を落としている。落とした条件は満たしている扱いになるので、発動率も短縮量も本来より高く出る。
      {!useField &&
        '順位条件を判定していないので、順位と距離差の条件はすべて落ちている側に入る。'}
      {' 印にカーソルを合わせると、どの条件がそうなのかが出る。'}
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
