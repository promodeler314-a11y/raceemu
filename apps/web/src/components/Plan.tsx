import { useMemo, useState } from 'react';
import type { Route } from '../../../../packages/solver/src/candidates.ts';
import { planCandidatesOf, useStore, type CandidateSource } from '../store.ts';

/**
 * 候補の出どころの入力。
 *
 * 候補をいま選んでいるスキルからではなく、入手経路（育成計画）か、
 * 買えるスキル全体から組み立てる。docs/solver-design.md 7 節と
 * docs/server-design.md 1 節を参照。
 */

const fieldCls = 'w-full rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm';

export const ROUTE_LABEL: Record<Route, string> = {
  chara: 'ウマ娘',
  hint: 'ヒント',
  inherit: '継承（白）',
  inheritedUnique: '継承（固有）',
  any: '経路不問',
};

const ROUTES: readonly Route[] = ['chara', 'hint', 'inherit', 'inheritedUnique', 'any'];

const SOURCES: readonly { readonly value: CandidateSource; readonly label: string }[] = [
  { value: 'selected', label: 'いま選んでいるスキル' },
  { value: 'plan', label: '育成計画' },
  { value: 'all', label: '全スキル' },
];

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

  // 印（▲）は順位条件を判定するかどうかで動くので、そちらも見る。
  const useField = useStore((s) => s.useField);
  // 候補が多いのにブラウザで回そうとしていないか。値は個別に選ぶ。
  const searchEndpoint = useStore((s) => s.searchEndpoint);
  const searchTarget = useStore((s) => s.searchTarget);

  // 候補の組み立てはスキル 2000 件を走査するので、入力が変わったときだけやり直す。
  const preview = useMemo(
    () => planCandidatesOf(useStore.getState()),
    [plan, uma, track, options, deck, useField],
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

  const routeParts =
    preview === null
      ? []
      : ROUTES.filter((route) => preview.countByRoute[route] > 0).map(
          (route) => `${ROUTE_LABEL[route]} ${preview.countByRoute[route]}`,
        );

  const selectedCards = plan.cardIds
    .map((id) => deck?.supportsById.get(id))
    .filter((card): card is NonNullable<typeof card> => card !== undefined);

  return (
    <div className="rounded-sm border border-rule p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-semibold">候補の出どころ</span>
        {SOURCES.map((choice) => (
          <label key={choice.value} className="flex items-center gap-1 text-sm">
            <input
              type="radio"
              name="plan-source"
              checked={plan.source === choice.value}
              onChange={() => setPlan({ source: choice.value })}
            />
            {choice.label}
          </label>
        ))}
      </div>

      {plan.source === 'selected' && (
        <p className="mt-2 text-xs text-ink3">
          育成計画に切り替えると、候補を育成ウマ娘とデッキ、それに継承から組み立てる。
          育て終わった馬の買い物ではなく、何を狙って育てるかを探せる。
          全スキルに切り替えると入手経路も問わなくなるが、候補が数百になるので
          ブラウザでは回りきらない。サーバに投げる設定と併せて使う。
        </p>
      )}

      {plan.source === 'plan' && deck === null && (
        <p className="mt-2 text-xs text-ink3">サポートカードと育成ウマ娘のデータを読み込んでいる。</p>
      )}

      {plan.source === 'all' && (
        <p className="mt-2 text-xs text-ink3">
          買えるスキル全体を候補にする。どのデッキで取れるかは問わないので、割引も当たらない
          （費用は表示どおりの総額になる）。これが本来の問いだが、候補が数百になり
          ブラウザの数コアでは回りきらない。下のサーバの宛先と併せて使う。
        </p>
      )}

      {plan.source === 'all' && (
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={plan.openWhites}
              onChange={(e) => setPlan({ openWhites: e.target.checked })}
            />
            白
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={plan.openGolds}
              onChange={(e) => setPlan({ openGolds: e.target.checked })}
            />
            金
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={plan.openInheritedUniques}
              onChange={(e) => setPlan({ openInheritedUniques: e.target.checked })}
            />
            固有の継承版（6 つまで）
          </label>
        </div>
      )}

      {plan.source === 'plan' && deck !== null && (
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
                    className="rounded-sm border border-rule2 px-2 py-0.5 text-xs hover:bg-sunken"
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
          </div>
        </div>
      )}

      {/*
        候補の落とし方は育成計画と全スキルで共通なので、どちらでも出す。
        ▲ のつまみがいちばん効くのは全スキルのほうである。
      */}
      {plan.source !== 'selected' && (
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={plan.excludeDropped}
              onChange={(e) => setPlan({ excludeDropped: e.target.checked })}
              data-testid="exclude-dropped"
            />
            条件を落としているスキル（▲）を外す
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
      )}

      {plan.source !== 'selected' && preview !== null && (
        <p className="mt-2 text-xs text-ink3" data-testid="plan-candidates">
          {/* 全スキルは経路を問わないので 1 通りしかない。内訳は 2 通り以上あるときだけ出す。 */}
          候補 {preview.skillIds.length} 個{routeParts.length > 1 ? `：${routeParts.join('、')}` : ''}
          。いまのコースと脚質で発動しようがないものは、走らせる前に落としてある。
          {preview.droppedByIgnored.length > 0 && (
            <>
              {' '}
              順位や他のウマ娘の顔ぶれに依る条件はモデルが判定できず、必ず発動する扱いになるため、
              それしか条件を持たない {preview.droppedByIgnored.length} 個も外してある。
            </>
          )}
          {preview.droppedByFidelity.length > 0 && (
            <>
              {' '}
              条件の一部を落としている（▲）{preview.droppedByFidelity.length} 個も外してある。
              落とした条件は満たしている扱いになるので、入れると上位がそれで埋まる。
            </>
          )}
        </p>
      )}

      {/*
        候補が数百あるのにブラウザで回そうとしている場合。押してから気付くと、
        中断するまで数十分戻ってこない（docs/server-design.md 1 節）。
      */}
      {plan.source !== 'selected' &&
        preview !== null &&
        preview.skillIds.length > 100 &&
        !(searchEndpoint.trim() !== '' && searchTarget === 'server') && (
          <p className="mt-2 rounded-sm border border-warn-rule bg-warn-tint px-3 py-2 text-xs text-warn-ink">
            候補 {preview.skillIds.length} 個をブラウザで回すと、数コアでは数十分かかる。
            サーバの宛先を入れて投げ先をサーバにするか、種類を絞って候補を減らす。
          </p>
        )}
    </div>
  );
}
