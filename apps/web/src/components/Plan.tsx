import { useMemo, useState } from 'react';
import type { Route } from '../../../../packages/solver/src/candidates.ts';
import { planCandidatesOf, useStore } from '../store.ts';

/**
 * 育成計画の入力。
 *
 * 候補をいま選んでいるスキルからではなく、入手経路から組み立てる。
 * docs/solver-design.md 7 節を参照。
 */

const fieldCls = 'w-full rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm';

export const ROUTE_LABEL: Record<Route, string> = {
  chara: 'ウマ娘',
  hint: 'ヒント',
  inherit: '継承（白）',
  inheritedUnique: '継承（固有）',
};

const ROUTES: readonly Route[] = ['chara', 'hint', 'inherit', 'inheritedUnique'];

/** `[勝負服]ウマ娘名` から勝負服の名前を落とす。並べ替えと検索に使う。 */
function charaNameOf(name: string): string {
  const end = name.indexOf(']');
  return end < 0 ? name : name.slice(end + 1);
}

export function PlanInput() {
  const plan = useStore((s) => s.plan);
  const uma = useStore((s) => s.uma);
  const track = useStore((s) => s.track);
  const options = useStore((s) => s.options);
  const setPlan = useStore((s) => s.setPlan);
  const toggleCard = useStore((s) => s.togglePlanCard);
  const deck = useStore((s) => s.deck);
  const [query, setQuery] = useState('');

  // 候補の組み立てはスキル 2000 件を走査するので、入力が変わったときだけやり直す。
  const preview = useMemo(
    () => (plan.enabled ? planCandidatesOf(useStore.getState()) : null),
    [plan, uma, track, options, deck],
  );

  const charaChoices = useMemo(
    () =>
      deck === null
        ? []
        : [...deck.charas].sort((a, b) =>
            charaNameOf(a.name).localeCompare(charaNameOf(b.name), 'ja'),
          ),
    [deck],
  );

  const matched = useMemo(() => {
    const text = query.trim();
    if (deck === null || text === '') return [];
    return deck.supports
      .filter((card) => card.name.includes(text) || card.chara.includes(text))
      .slice(0, 30);
  }, [deck, query]);

  const selectedCards = plan.cardIds
    .map((id) => deck?.supportsById.get(id))
    .filter((card): card is NonNullable<typeof card> => card !== undefined);

  return (
    <div className="rounded-sm border border-rule p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-semibold">候補の出どころ</span>
        {[
          { value: false, label: 'いま選んでいるスキル' },
          { value: true, label: '育成計画' },
        ].map((choice) => (
          <label key={String(choice.value)} className="flex items-center gap-1 text-sm">
            <input
              type="radio"
              name="plan-source"
              checked={plan.enabled === choice.value}
              onChange={() => setPlan({ enabled: choice.value })}
            />
            {choice.label}
          </label>
        ))}
      </div>

      {!plan.enabled && (
        <p className="mt-2 text-xs text-ink3">
          育成計画に切り替えると、候補を育成ウマ娘とデッキ、それに継承から組み立てる。
          育て終わった馬の買い物ではなく、何を狙って育てるかを探せる。
        </p>
      )}

      {plan.enabled && deck === null && (
        <p className="mt-2 text-xs text-ink3">サポートカードと育成ウマ娘のデータを読み込んでいる。</p>
      )}

      {plan.enabled && deck !== null && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-xs text-ink3">育成ウマ娘</span>
              <select
                className={fieldCls}
                value={plan.charaId ?? ''}
                onChange={(e) =>
                  setPlan({ charaId: e.target.value === '' ? null : Number(e.target.value) })
                }
              >
                <option value="">選ばない（金と固有を候補に入れない）</option>
                {charaChoices.map((chara) => (
                  <option key={chara.id} value={chara.id}>
                    {chara.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs text-ink3">覚醒ランク</span>
              <select
                className={fieldCls}
                value={plan.charaRank}
                onChange={(e) => setPlan({ charaRank: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5].map((rank) => (
                  <option key={rank} value={rank}>
                    {rank}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div>
            <span className="block text-xs text-ink3">
              サポートカード（{selectedCards.length} / 6 枚）
            </span>
            <input
              className={`${fieldCls} mt-1`}
              placeholder="カード名かウマ娘名で検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {matched.length > 0 && (
              <ul className="mt-1 max-h-40 overflow-y-auto rounded-sm border border-rule text-sm">
                {matched.map((card) => (
                  <li key={card.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-2 py-1 text-left hover:bg-sunken"
                      onClick={() => toggleCard(card.id)}
                    >
                      <span>{card.name}</span>
                      <span className="text-xs text-ink3">
                        {plan.cardIds.includes(card.id) ? '選択中' : `ヒント ${card.skills.length}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selectedCards.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {selectedCards.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className="rounded-full border border-rule2 px-2 py-0.5 text-xs hover:bg-sunken"
                    onClick={() => toggleCard(card.id)}
                  >
                    {card.name} <span className="text-ink3">×</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={plan.openWhites}
                onChange={(e) => setPlan({ openWhites: e.target.checked })}
              />
              汎用の白を継承で開く
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={plan.openInheritedUniques}
                onChange={(e) => setPlan({ openInheritedUniques: e.target.checked })}
              />
              固有の継承版を開く（6 つまで）
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={plan.includeIgnoredOnly}
                onChange={(e) => setPlan({ includeIgnoredOnly: e.target.checked })}
              />
              判定できない条件のスキルも入れる
            </label>
          </div>

          {preview !== null && (
            <p className="text-xs text-ink3" data-testid="plan-candidates">
              候補 {preview.skillIds.length} 個：
              {ROUTES.map((route) => `${ROUTE_LABEL[route]} ${preview.countByRoute[route]}`).join('、')}
              。いまのコースと脚質で発動しようがないものは、走らせる前に落としてある。
              {preview.droppedByIgnored.length > 0 && (
                <>
                  {' '}
                  順位や他のウマ娘の顔ぶれに依る条件はモデルが判定できず、必ず発動する扱いになるため、
                  それしか条件を持たない {preview.droppedByIgnored.length} 個も外してある。
                </>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
