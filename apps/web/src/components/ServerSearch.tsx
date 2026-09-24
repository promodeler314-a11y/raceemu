import { useState } from 'react';
import { checkHealth } from '../searchApi.ts';
import { defaultFieldSetting, useStore } from '../store.ts';

/**
 * 探索の投げ先。
 *
 * 候補を数百に広げると 25 万レース規模になり、ブラウザの数コアでは回らない。
 * サーバに投げる口をここに置く（docs/server-design.md 8 節の 5）。
 *
 * **宛先が空なら今までどおりブラウザで回す。** サーバは加速装置であって
 * 依存先ではない（同 2 節）。静的ファイルだけを置いた版には口が無いので、
 * 宛先を入れていても届かなければブラウザに落ちる。
 */

const fieldCls = 'w-full rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm';

/** 相手の想定が既定のままか。サーバは既定でしか組まないので、違えば知らせる。 */
function isDefaultField(field: ReturnType<typeof defaultFieldSetting>): boolean {
  const base = defaultFieldSetting();
  return (
    field.matchSelf === base.matchSelf &&
    field.offset === base.offset &&
    field.sigma === base.sigma &&
    field.redrawComposition === base.redrawComposition &&
    field.withSkills === base.withSkills
  );
}

export function ServerSearchInput() {
  const endpoint = useStore((s) => s.searchEndpoint);
  const setEndpoint = useStore((s) => s.setSearchEndpoint);
  const target = useStore((s) => s.searchTarget);
  const setTarget = useStore((s) => s.setSearchTarget);
  const running = useStore((s) => s.optimizeRunning);
  const useField = useStore((s) => s.useField);
  const field = useStore((s) => s.field);
  const selfConsistent = useStore((s) => s.optimizeSelfConsistent);
  const [health, setHealth] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const configured = endpoint.trim() !== '';
  const toServer = configured && target === 'server';

  const check = async () => {
    setChecking(true);
    setHealth(null);
    try {
      const info = await checkHealth(endpoint);
      setHealth(
        `繋がりました。Worker ${info.concurrency} 本（${info.concurrencySource}）・` +
          `実行中 ${info.running} 本・待ち ${info.queued} 本・` +
          `1 ジョブ ${info.maxRacesPerJob.toLocaleString()} レースまで`,
      );
    } catch (error) {
      setHealth(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="mt-3 border-t border-rule pt-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs text-ink3">探索を投げるサーバ</span>
          <input
            className={fieldCls}
            data-testid="search-endpoint"
            placeholder="空ならブラウザで回します。同一オリジンなら / を書いてください。"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            disabled={running}
          />
        </label>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <span className="text-xs text-ink3">投げ先</span>
          {(
            [
              { value: 'browser', label: 'ブラウザ' },
              { value: 'server', label: 'サーバ' },
            ] as const
          ).map((choice) => (
            <label key={choice.value} className="flex items-center gap-1">
              <input
                type="radio"
                name="search-target"
                data-testid={`search-target-${choice.value}`}
                checked={(configured ? target : 'browser') === choice.value}
                onChange={() => setTarget(choice.value)}
                disabled={running || !configured}
              />
              {choice.label}
            </label>
          ))}
          <button
            type="button"
            className="rounded-sm border border-rule2 px-3 py-1 text-xs disabled:opacity-50"
            onClick={() => void check()}
            disabled={!configured || checking}
          >
            {checking ? '確認中' : '疎通の確認'}
          </button>
        </div>
      </div>

      {!configured && (
        <p className="mt-2 text-xs text-ink3">
          宛先を入れるとサーバに投げられます。入れなければ今までどおりブラウザの中で回します。
        </p>
      )}
      {health !== null && (
        <p className="mt-2 text-xs text-ink3" data-testid="search-health">
          {health}
        </p>
      )}
      {toServer && (
        <p className="mt-2 text-xs text-ink3">
          届かなければブラウザで回します。断られたとき（候補が多すぎる、混んでいる、レース数の上限）は
          止めて理由を出します。重い探索を黙ってブラウザに回すと数十分固まるためです。
        </p>
      )}
      {/*
        サーバ側は相手の束を既定の作り方でしか組まない（docs/server-design.md 7 節）。
        自己整合も口が受け取らない。黙って別物を返すのがいちばん悪いので、
        食い違う設定のときだけはっきり言う。
      */}
      {toServer && useField && (selfConsistent || !isDefaultField(field)) && (
        <p className="mt-2 rounded-sm border border-warn-rule bg-warn-tint px-3 py-2 text-xs text-warn-ink">
          サーバは相手の束を既定の作り方でしか組みません。
          {selfConsistent && '自己整合は反映されません。'}
          {!isDefaultField(field) && '相手の想定（強さ・ばらつき・脚質構成）も既定に戻ります。'}
          同じ条件で比べたいなら、投げ先をブラウザにしてください。
        </p>
      )}
    </div>
  );
}
