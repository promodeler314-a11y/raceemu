import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useStore } from '../store.ts';

/**
 * 実行中に起きた失敗を、画面の上端にまとめて出す。
 *
 * これまでは実行パネルの中に小さく出していたが、逆算や探索の失敗も同じ
 * 変数に入るため、走らせた場所と表示される場所が食い違っていた。
 */
export function ErrorBanner() {
  const error = useStore((s) => s.error);
  const notice = useStore((s) => s.notice);
  const dismissError = useStore((s) => s.dismissError);
  const dismissNotice = useStore((s) => s.dismissNotice);

  if (error === null && notice === null) return null;

  return (
    <div className="mx-auto max-w-6xl px-4 pt-4">
      {error !== null && (
        <div
          role="alert"
          className="mb-2 flex items-start gap-3 rounded-sm border border-bad-rule bg-bad-tint px-3 py-2 text-sm text-bad-ink"
        >
          <span className="flex-1">{error}</span>
          <button
            type="button"
            className="shrink-0 underline"
            onClick={dismissError}
            aria-label="この知らせを閉じる"
          >
            閉じる
          </button>
        </div>
      )}
      {notice !== null && (
        <div
          role="status"
          className="mb-2 flex items-start gap-3 rounded-sm border border-rule2 bg-sunken px-3 py-2 text-sm"
        >
          <span className="flex-1">{notice}</span>
          <button
            type="button"
            className="shrink-0 underline"
            onClick={dismissNotice}
            aria-label="この知らせを閉じる"
          >
            閉じる
          </button>
        </div>
      )}
    </div>
  );
}

interface BoundaryState {
  readonly error: Error | null;
}

/**
 * 描画そのものが失敗したときの受け皿。
 *
 * スキルデータの読み込みは起動時に同期で走るため、そこで例外が出ると
 * 白い画面だけが残る。何が起きたかと、次に何をすればよいかを出す。
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('画面の描画に失敗した', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-base font-semibold">画面を表示できませんでした</h1>
        <p className="mt-2 text-sm text-ink2">
          計算モデルかコースデータの読み込みでつまずいています。ページを開き直すと直ることが
          あります。直らないときは、保存してある設定が壊れている可能性があるので、下のボタンで
          消してから開き直してください。
        </p>
        <pre className="mt-3 overflow-x-auto rounded-sm bg-sunken p-3 text-xs">
          {error.message}
        </pre>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="rounded-sm bg-primary-bg px-3 py-1.5 text-sm text-primary-fg"
            onClick={() => location.reload()}
          >
            開き直す
          </button>
          <button
            type="button"
            className="rounded-sm border border-rule2 px-3 py-1.5 text-sm"
            onClick={() => {
              try {
                indexedDB.deleteDatabase('raceemu');
              } catch {
                // 消せなくても、開き直す道は残る。
              }
              location.href = location.pathname;
            }}
          >
            保存した設定を消して開き直す
          </button>
        </div>
      </div>
    );
  }
}
