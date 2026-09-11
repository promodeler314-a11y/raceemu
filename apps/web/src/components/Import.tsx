import { useRef, useState } from 'react';
import { currentTrackDetail, useStore } from '../store.ts';
import { Panel } from './Inputs.tsx';
import type { FitRank } from '../../../../packages/sim/src/data/constants.ts';

/**
 * スキル画面の写真から所持スキルを取り込む。
 *
 * 読み取りはサーバ側で行う。画像はブラウザから `/api/ocr/skills` に送る。
 * 静的ファイルだけを置いた版にはサーバが無いので、その場合は口が無いことを伝える。
 */

/** 口そのものが無いときに出す文言 */
const NO_ENDPOINT =
  '読み取りの口が無い。静的ファイルだけを置いた版はサーバを持たないので、この機能はサーバを立てた版でだけ使える。';

/**
 * JSON でない応答が返ったときに、何が起きたのかを言い分ける。
 *
 * 静的配信だけの環境なら口が無い。
 * それ以外で HTML が返るのは、途中に認証や proxy の画面が挟まっているか、
 * サーバが M10 より前の版であるときである。
 * どちらなのかを人が切り分けられるよう、状態番号をそのまま出す。
 */
function explainNonJson(res: Response): string {
  if (res.redirected) {
    return `読み取りの口ではなく別の画面に飛ばされた（最終 ${res.status}）。認証が切れていないか確かめる。`;
  }
  if (res.status === 404 || res.status === 405) return NO_ENDPOINT;
  return (
    `サーバが JSON ではない応答を返した（${res.status}）。` +
    'サーバの版が古いか、途中に認証や proxy の画面が挟まっている。/api/health を開くと切り分けられる。'
  );
}

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
        setMessage(explainNonJson(res));
        return;
      }

      let body: { matches?: Match[]; error?: string; elapsedMs?: number };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        setMessage(explainNonJson(res));
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
        スキル一覧の写真を送ると、写っているスキル名を読み取って所持スキルの候補にする。
        読み取りはサーバ側で動くので、自前で立てた版でだけ使える。
      </p>
      <p className="mt-1 text-xs text-ink3">
        ステータスやキャラの写真を含む画面全体ではなく、スキル名が並んだ部分だけを切り抜いて送る。
        アイコンや背景の模様が文字に被ると、読み取りの精度が大きく落ちる（
        <a
          href="https://github.com/promodeler314-a11y/raceemu/blob/main/docs/ocr-design.md"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          詳細
        </a>
        ）。
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

/** サーバが返す適性の並び。`apps/api/src/status-header.ts` の `APTITUDE_KEYS` と同じ。 */
const APTITUDE_LABELS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'turf', label: '芝' },
  { key: 'dirt', label: 'ダート' },
  { key: 'sprint', label: '短距離' },
  { key: 'mile', label: 'マイル' },
  { key: 'middle', label: '中距離' },
  { key: 'long', label: '長距離' },
  { key: 'nige', label: '逃げ' },
  { key: 'sen', label: '先行' },
  { key: 'sasi', label: '差し' },
  { key: 'oi', label: '追込' },
];

const STATUS_LABELS = ['スピード', 'スタミナ', 'パワー', '根性', '賢さ'] as const;

const STYLE_TO_APTITUDE: Record<string, string> = {
  NIGE: 'nige',
  SEN: 'sen',
  SASI: 'sasi',
  OI: 'oi',
};

/** コースの距離区分（1 から 4）から適性の欄へ。track.ts の distanceCategory と同じ並び。 */
const DISTANCE_TO_APTITUDE = ['sprint', 'mile', 'middle', 'long'];

interface StatusReading {
  readonly status: readonly (number | null)[];
  readonly aptitudes: Readonly<Record<string, FitRank | null>>;
}

/**
 * 「ウマ娘詳細」画面の上半分から、ステータスと適性を取り込む。
 *
 * **適性は 10 個あるが、この計算モデルが使うのは 3 つだけである。** バ場と
 * 距離はいま選んでいるコースで、脚質はいま選んでいる脚質で決まる。どれを
 * 当てたかが分かるように、読み取った 10 個を全部出したうえで、当てる 3 つに
 * 印を付ける。コースや脚質を変えたら取り込み直す必要がある。
 */
export function StatusImportPanel() {
  const setUma = useStore((s) => s.setUma);
  const uma = useStore((s) => s.uma);
  const track = useStore((s) => s.track);
  const detail = currentTrackDetail(track);
  const [reading, setReading] = useState<StatusReading | null>(null);
  const [state, setState] = useState<'idle' | 'running'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const surfaceKey = detail === undefined ? null : detail.surface === 1 ? 'turf' : 'dirt';
  const distanceKey =
    detail === undefined ? null : (DISTANCE_TO_APTITUDE[detail.distanceType - 1] ?? null);
  const styleKey = STYLE_TO_APTITUDE[uma.style] ?? null;
  const used = new Set([surfaceKey, distanceKey, styleKey].filter((k): k is string => k !== null));

  const send = async (file: File) => {
    setState('running');
    setMessage(null);
    setReading(null);
    try {
      const res = await fetch('/api/ocr/status', {
        method: 'POST',
        headers: { 'content-type': file.type || 'image/png' },
        body: file,
      });
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        setMessage(explainNonJson(res));
        return;
      }
      let body: StatusReading & { error?: string };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        setMessage(explainNonJson(res));
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
      setReading(body);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setState('idle');
    }
  };

  const apply = () => {
    if (reading === null) return;
    const [speed, stamina, power, guts, wisdom] = reading.status;
    const patch: Record<string, number | FitRank> = {};
    if (speed != null) patch['speed'] = speed;
    if (stamina != null) patch['stamina'] = stamina;
    if (power != null) patch['power'] = power;
    if (guts != null) patch['guts'] = guts;
    if (wisdom != null) patch['wisdom'] = wisdom;
    const surface = surfaceKey === null ? null : reading.aptitudes[surfaceKey];
    const distance = distanceKey === null ? null : reading.aptitudes[distanceKey];
    const style = styleKey === null ? null : reading.aptitudes[styleKey];
    if (surface != null) patch['surfaceFit'] = surface;
    if (distance != null) patch['distanceFit'] = distance;
    if (style != null) patch['styleFit'] = style;
    setUma(patch as never);
    setMessage(`${Object.keys(patch).length} 項目を設定に入れた。`);
  };

  return (
    <Panel title="画面からステータスを取り込む">
      <p className="text-xs text-ink3">
        「ウマ娘詳細」画面の<strong>上半分</strong>（ステータスの数字と適性が写っている部分）を送る。
        スキル一覧と違い、切り抜かずに画面全体のまま送ってよい。位置は画面の横幅に対する割合で決まる。
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
          {state === 'running' ? '読み取り中' : 'ステータスの画像を選ぶ'}
        </button>
        {reading !== null && (
          <button
            type="button"
            className="rounded-sm border border-rule2 px-3 py-1.5 text-sm"
            onClick={apply}
          >
            設定に入れる
          </button>
        )}
      </div>
      {message !== null && <p className="mt-2 text-xs text-ink2">{message}</p>}

      {reading !== null && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <table className="w-full text-xs">
            <tbody>
              {STATUS_LABELS.map((label, index) => (
                <tr key={label} className="border-t border-rule2">
                  <th scope="row" className="py-1 text-left font-normal text-ink3">
                    {label}
                  </th>
                  <td className="py-1 text-right tabular-nums">
                    {reading.status[index] ?? '読めなかった'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="w-full text-xs">
            <tbody>
              {APTITUDE_LABELS.map(({ key, label }) => (
                <tr key={key} className="border-t border-rule2">
                  <th scope="row" className="py-1 text-left font-normal text-ink3">
                    {label}
                    {used.has(key) && (
                      <span className="ml-1 rounded-sm border border-rule2 px-1" title="いまのコースと脚質で使う">
                        使う
                      </span>
                    )}
                  </th>
                  <td className="py-1 text-right tabular-nums">
                    {reading.aptitudes[key] ?? '—'}
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
