import { useRef, useState } from 'react';
import { useStore } from '../store.ts';
import { Panel } from './Inputs.tsx';

/**
 * スキル画面の写真から所持スキルを取り込む。
 *
 * 読み取りはサーバ側で行う。画像はブラウザから `/api/ocr/skills` に送る。
 * GitHub Pages に置いた版にはサーバが無いので、その場合は口が無いことを伝える。
 */

/** 口そのものが無いときに出す文言 */
const NO_ENDPOINT =
  '読み取りの口が無い。GitHub Pages に置いた版はサーバを持たないので、この機能は自前で立てた版でだけ使える。';

interface Match {
  readonly id: string;
  readonly name: string;
  readonly rarity: string;
  readonly sp: number;
  readonly text: string;
  readonly score: number;
  readonly margin: number;
  readonly runnerUp: { readonly id: string; readonly name: string } | null;
}

/**
 * 紛らわしい一致。人が見て決める必要がある。
 *
 * 正規化して完全に一致したものは、似た名前が隣にあっても紛らわしくない。
 * 「中距離コーナー○」は「中距離コーナー◎」と 1 文字しか違わないが、
 * 読み取った文字が前者と完全に一致しているなら迷う余地は無い。
 */
function uncertain(match: Match): boolean {
  if (match.score >= 1) return false;
  return match.score < 0.9 || match.margin < 0.15;
}

export function ImportPanel() {
  const skillIds = useStore((s) => s.skillIds);
  const toggleSkill = useStore((s) => s.toggleSkill);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [state, setState] = useState<'idle' | 'running'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const send = async (file: File) => {
    setState('running');
    setMessage(null);
    setMatches(null);
    try {
      const res = await fetch('/api/ocr/skills', {
        method: 'POST',
        headers: { 'content-type': file.type || 'image/png' },
        body: file,
      });

      // 静的ファイルしか置いていない環境では、POST に HTML が返る。
      // 状態番号は環境によって 404 にも 405 にも 200 にもなるので、
      // 中身が JSON かどうかで判断する。HTML を JSON として読むと落ちる。
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        setMessage(NO_ENDPOINT);
        return;
      }

      let body: { matches?: Match[]; error?: string; elapsedMs?: number };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        setMessage(NO_ENDPOINT);
        return;
      }

      if (res.status === 404) {
        setMessage(NO_ENDPOINT);
        return;
      }
      if (!res.ok) {
        setMessage(body.error ?? `読み取りに失敗した（${res.status}）`);
        return;
      }
      const found = body.matches ?? [];
      setMatches(found);
      setElapsed(body.elapsedMs ?? 0);
      // 紛らわしくないものは最初から選んでおく
      setPicked(new Set(found.filter((m) => !uncertain(m)).map((m) => m.id)));
      if (found.length === 0) setMessage('スキルらしい文字が見つからなかった。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setState('idle');
    }
  };

  const apply = () => {
    for (const id of picked) if (!skillIds.includes(id)) toggleSkill(id);
    setMessage(`${picked.size} 個を所持スキルに入れた。`);
  };

  return (
    <Panel title="画面から取り込む">
      <p className="text-xs text-ink3">
        スキル画面の写真を送ると、写っているスキル名を読み取って所持スキルの候補にする。
        読み取りはサーバ側で動くので、自前で立てた版でだけ使える。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void send(file);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="rounded-sm bg-ink px-4 py-1.5 text-sm text-paper disabled:opacity-50"
          onClick={() => inputRef.current?.click()}
          disabled={state === 'running'}
        >
          {state === 'running' ? '読み取り中' : '画像を選ぶ'}
        </button>
        {matches !== null && matches.length > 0 && (
          <>
            <button
              type="button"
              className="rounded-sm border border-rule2 px-3 py-1.5 text-sm disabled:opacity-50"
              onClick={apply}
              disabled={picked.size === 0}
            >
              選んだ {picked.size} 個を入れる
            </button>
            <span className="text-xs text-ink3">読み取り {(elapsed / 1000).toFixed(1)} 秒</span>
          </>
        )}
      </div>
      {message !== null && <p className="mt-2 text-xs text-ink2">{message}</p>}

      {matches !== null && matches.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-xs text-ink3">
            確からしくない一致には読み取った文字を添えてある。見比べてから入れる。
          </p>
          <table className="w-full text-xs">
            <thead className="text-ink3">
              <tr>
                <th className="pb-1 pr-2" />
                <th className="pb-1 pr-2 text-left">スキル</th>
                <th className="pb-1 pr-2 text-right">pt</th>
                <th className="pb-1 text-right">一致</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((match) => (
                <tr key={match.id} className="border-t border-rule2 align-top">
                  <td className="py-1 pr-2">
                    <input
                      type="checkbox"
                      aria-label={`${match.name} を取り込む`}
                      checked={picked.has(match.id)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(match.id);
                        else next.delete(match.id);
                        setPicked(next);
                      }}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <span>{match.name}</span>
                    {skillIds.includes(match.id) && (
                      <span className="ml-1 rounded-sm border border-rule2 px-1 text-ink3">済</span>
                    )}
                    {uncertain(match) && (
                      <span className="block text-ink3">
                        読み取り「{match.text}」
                        {match.runnerUp !== null && `／${match.runnerUp.name} かもしれない`}
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">{match.sp}</td>
                  <td className="py-1 text-right tabular-nums">
                    {uncertain(match) ? (
                      <span className="rounded-sm border border-rule2 px-1">要確認</span>
                    ) : (
                      `${(100 * match.score).toFixed(0)} %`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
