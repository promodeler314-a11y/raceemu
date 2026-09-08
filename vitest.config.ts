import { defineConfig } from 'vitest/config';

/**
 * テスト 1 件あたりの制限時間。
 *
 * このリポジトリのテストは実際にレースを回す。本家との突き合わせは 400 試行、
 * 組み合わせ探索は数千レースを走らせるので、1 件で数秒から数十秒かかる。
 * vitest の既定は 5 秒で、これには短すぎる。
 *
 * これまで表に出なかったのは、テストの多くが同期でメインスレッドを占有し、
 * その間はタイムアウトの時計が進めないためである。Worker を待つ非同期の
 * テストだけが実際に打ち切られる。`optimize.test.ts` は個別に指定して
 * 避けていたが、`field.test.ts` と `critical.test.ts` は指定が無く、
 * 遅い実行環境では落ちる。実際 CI で `field.test.ts` が落ちた。
 *
 * 120 秒はいちばん長いテストの数倍にあたる。本当に固まった場合は捕まえられる。
 */
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
