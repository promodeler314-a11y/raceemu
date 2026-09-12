import { useState } from 'react';
import { transferIndex, transferTextOf, useStore } from '../store.ts';
import { parseTransfer } from '../transfer.ts';
import { Panel } from './Inputs.tsx';

/**
 * 本家との設定の受け渡し。
 *
 * 本家で作った設定を持ち込んで勝率や逆算に掛けられるようにする。
 * 形式と取りこぼしの扱いは `src/transfer.ts` にある。
 */
export function TransferPanel() {
  const applyTransfer = useStore((s) => s.applyTransfer);
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<readonly string[]>([]);

  const read = () => {
    const parsed = parseTransfer(text, transferIndex);
    const counts = [
      Object.keys(parsed.status).length > 0 ? `ステータス ${Object.keys(parsed.status).length} 項目` : null,
      Object.keys(parsed.fits).length > 0 ? `適性 ${Object.keys(parsed.fits).length} 項目` : null,
      parsed.charaName === null ? null : `キャラ ${parsed.charaName}`,
      parsed.skillIds.length > 0 ? `スキル ${parsed.skillIds.length} 個` : null,
    ].filter((x): x is string => x !== null);
    setUnknown(parsed.unknown);
    if (counts.length === 0) {
      setMessage('読めるものが無かった。区切りはカンマ、改行、タブ、コロン、スラッシュのどれでもよい。');
      return;
    }
    applyTransfer(parsed);
    setMessage(`${counts.join(' ／ ')} を入れた。`);
  };

  const write = () => {
    const out = transferTextOf(useStore.getState());
    setText(out);
    setUnknown([]);
    // クリップボードは許可が要る環境があるので、失敗しても欄には残す。
    void navigator.clipboard
      ?.writeText(out)
      .then(() => setMessage('書き出して、クリップボードに入れた。'))
      .catch(() => setMessage('書き出した。欄から写して使う。'));
  };

  return (
    <Panel title="本家と設定をやり取りする">
      <p className="text-xs text-ink3">
        キャラ名、ステータス 5 つ、適性 3 つ（距離・バ場・脚質）、スキル名を並べた 1 行である。
        脚質、やる気、コース、人気、枠番はこの形式に無いので触らない。
      </p>
      <textarea
        className="mt-2 h-20 w-full rounded-sm border border-rule2 bg-surface px-2 py-1 font-mono text-xs text-ink"
        value={text}
        spellCheck={false}
        placeholder="スペシャルウィーク,1200,1000,900,600,900,A,A,A,弧線のプロフェッサー,円弧のマエストロ"
        aria-label="本家の設定文字列"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-sm bg-ink px-3 py-1.5 text-xs text-paper disabled:opacity-50"
          onClick={read}
          disabled={text.trim() === ''}
        >
          読み込む
        </button>
        <button
          type="button"
          className="rounded-sm border border-rule2 px-3 py-1.5 text-xs"
          onClick={write}
        >
          いまの設定を書き出す
        </button>
      </div>
      {message !== null && (
        <p className="mt-2 text-xs text-ink2" data-testid="transfer-message">
          {message}
        </p>
      )}
      {unknown.length > 0 && (
        <p
          className="mt-2 rounded-sm border border-warn-rule bg-warn-tint px-3 py-2 text-xs text-warn-ink"
          data-testid="transfer-unknown"
        >
          引き当てられなかった語が {unknown.length} 個ある: {unknown.join('、')}
        </p>
      )}
    </Panel>
  );
}
