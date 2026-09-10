# 配信

`apps/web` を GitHub Pages に置く。
`https://promodeler314-a11y.github.io/raceemu/` である。

## 1. 静的ファイルだけで足りる

`pnpm build` が出すのは `apps/web/dist` の 4 ファイルで、サーバ側の処理は要らない。

| ファイル | 大きさ |
| --- | ---: |
| `index.html` | 1.26 kB |
| `assets/index-*.css` | 19.6 kB（gzip 5.0 kB） |
| `assets/index-*.js` | 1.55 MB（gzip 250 kB） |
| `assets/browser-worker-*.js` | 1.17 MB |

面倒になりがちな条件が四つとも外れている。

- **サブパスで配れる。** `base: './'` にしてあるので参照が相対になり、`/raceemu/` の下でもそのまま動く。
- **404 のフォールバックが要らない。** 共有 URL はハッシュ（`store.ts` の `shareUrl`）で表しており、History API を使っていない。
- **COOP/COEP を送らなくてよい。** `SharedArrayBuffer` を使っていないので、Worker は普通の配信で動く。
- **ソースが同じ場所にある。** リポジトリは公開で、フッタのリンク（`App.tsx`）が解決する。AGPL v3 の下で配る前提を満たす。

したがってホストの乗り換えは安い。
成果物は配信先に依存していない。

## 2. 検査を通してから配る

[ワークフロー](../.github/workflows/pages.yml)は `typecheck`、`test`、`build`、`e2e` の順に走らせ、通ったものだけを配る。

検査は pull request でも走らせ、デプロイだけを `main` に限る。

`e2e` を外さないのは、これがビルドした成果物を実際に配信してブラウザで叩く唯一の段だからである。
バンドルの上限、フッタのソースリンク、名前のないボタンの数、幅 390 での横あふれは、ここでしか見ていない。
単体テストは計算モデルを見ているので、配るものが壊れていることは検出しない。

ランナーにブラウザ本体は入っていないため、`playwright install` を挟む。

ランナーは手元より遅い。
テストは実際にレースを回すので 1 件で数秒から数十秒かかり、vitest の既定の 5 秒では足りない。
[設定](../vitest.config.ts)で 120 秒にしてある。
`smoke.mjs` は、開発コンテナに置いてある Chromium があればそれを使い、無ければ Playwright に探させる。

## 3. 最初の一回だけ手で要る操作

リポジトリの Settings → Pages で、Source を **GitHub Actions** にする。
既定の「Deploy from a branch」のままだとワークフローの `deploy` が失敗する。

## 4. 見ておくこと

- **モバイルでの Worker 数。** 既定は `hardwareConcurrency - 1`（`packages/sim/src/parallel/browser.ts`）なので、8 コアの端末では 7 本立ち上がり、それぞれ 1.17 MB を読む。上限を切るかは実機で測ってから決める。
- **ES module 形式の Worker。** `vite.config.ts` で `worker.format` を `es` にしている。Firefox は 114 から対応した。
- **反映までの間。** GitHub Pages の CDN は `index.html` を数分ほど持つ。資産のファイル名にはハッシュが付くので古い資産を掴むことはないが、更新が見えるまでに間がある。
