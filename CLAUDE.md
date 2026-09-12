# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ウマ娘レースエミュレータ（[mee1080/umasim](https://github.com/mee1080/umasim)）の計算モデルを TypeScript に移植し、並列実行、統計、比較、目標からの逆算、スキルの組み合わせ探索を載せた Web アプリである。
AGPL v3。コメントとドキュメントと commit メッセージはすべて日本語で書く。

**正しさの基準は「本家と統計的に一致すること」である。** モデルの係数を勘で変えてはならない。
本家の挙動を再現しているかは `packages/sim/test/reference.test.ts` が JVM で生成した参照値と突き合わせて判定する。

## コマンド

```
pnpm install --frozen-lockfile
pnpm typecheck                 # tsc -b。noEmit なのでビルド成果物は出ない
pnpm test                      # vitest run。21 ファイル 175 件
pnpm test packages/sim/test/plan.test.ts    # ファイルを絞る
pnpm exec vitest run packages/sim/test/optimize.test.ts -t '予算を超える構成は返さない'  # テスト名で絞る
pnpm dev                       # UI の開発サーバ
pnpm build                     # UI のビルド（apps/web/dist）
pnpm e2e                       # build した成果物を実ブラウザで叩く。バンドル上限も見る
pnpm api                       # サーバ側の口（apps/api）
pnpm fetch-tessdata            # 読み取り用の学習データ 35 MB を .tessdata に置く
```

モデルや探索を手元で実測する CLI が揃っている。数値の裏取りにはテストより先にこちらを使う。

```
pnpm sim --count 1000 --location 10006 --course 10606
pnpm bench --count 10000       # 並列実行の実測
pnpm monotonicity --trials 60  # 逆算の前提（単調性）の検査
pnpm optimize --budget 600 --style SEN
pnpm plan --chara スペシャルウィーク --budget 600
pnpm multi --trials 500        # 全頭同時
pnpm order-field --trials 200  # 順位条件の判定が相手の作り方でどう変わるか
```

テスト名で絞るときは `pnpm exec vitest` を直に呼ぶ。`pnpm test -t '...'` は `-t` が転送されず、**黙って全件走る**。

リンタは入れていない。検査は `typecheck` と `test` の 2 つである。
CI（`.github/workflows/ci.yml`）は Node 22 で `typecheck` → `fetch-tessdata` → `test` → `build` → `e2e` を通す。pnpm の版は `package.json` の `packageManager` から読まれる。

### テストの前提

175 件のうち 11 件は手元の材料に依り、無ければ静かに飛ぶ。**緑でも全部通ったとは限らない。**

- 読み取りの 5 件：`.tessdata/jpn.traineddata`（`pnpm fetch-tessdata`）が必要。
- ステータス読み取りの 6 件：`RACEEMU_REAL_SCREENSHOT_DIR` に実機の写真を置いた場所を指す。写真はゲームの著作物なのでリポジトリに無い。

テストは実際にレースを回すので 1 件で数十秒かかる。`vitest.config.ts` が `testTimeout` を 120 秒に上げているのはそのためで、既定の 5 秒には戻せない。

## 構成

| 場所 | 役目 |
| --- | --- |
| `packages/sim` | 計算モデル。DOM にも Node にも依存しない |
| `packages/data` | コース、スキル、サポートカード、育成ウマ娘のデータと loader |
| `packages/solver` | 逆算と組み合わせ探索 |
| `apps/web` | React + Zustand + Tailwind + uPlot の UI |
| `apps/api` | 探索、画面の読み取り、個体の保存。静的ファイルも同一オリジンで配る |
| `docs` | 設計書と各回の報告。コード中のコメントが節番号で参照している |
| `design` | 画面モック（`.dc.html`）。ズレは `docs/ui-gap.md` |

**パッケージ間の import は相対パスに `.ts` 拡張子を付けて書く。** `@raceemu/sim` のような名前は `package.json` にあるだけで、どこからも import していない（`tsconfig.json` の `allowImportingTsExtensions`、ビルド段を持たない方針）。既存の書き方に揃えること。

`packages/data/assets/*.json` は週次のワークフローが本家から取り直して下書き PR を出す。手で編集しない。

## 設計の土台

### 乱数のストリーム分離

`packages/sim/src/rng.ts` が、用途ごとに独立した乱数列を `(baseSeed, trial, streamKey)` から導く。
これにより同じ試行番号では「動かした値以外の出目が変わらない」ので、**共通乱数によるペア比較**が成立する。
逆算（試行ごとの臨界値）、組み合わせ探索（候補の差分）、設定どうしの比較はすべてこの性質に乗っている。

ここを壊すと「効かないスキルを足したときの差が厳密に 0 になる」（`packages/sim/test/optimize.test.ts`）が落ちる。乱数の消費順を変える変更は、この 1 件を必ず確認する。

### レースの回し方が 3 通りある

どれを使っているかで順位条件の扱いが変わるので、結果を読むときに取り違えないこと。

1. **単騎**（`calculator.ts` の `simulate`）：本家と同じ。順位条件は満たしている前提になる。
2. **フィールド**（`field/field.ts`）：他馬の位置の時系列を先に生成して渡す。他馬は自分の影響を受けないと割り切るので、全試行と全候補で使い回せる。順位条件を実際に判定する。
3. **全頭同時**（`multi/race.ts`）：1 フレームを二段階に分け、全頭の位置を置いてから全頭を進める。並び順が結果に効かないようにするためで、この順序を崩してはならない。

### 並列実行

`parallel/pool.ts` の `WorkerPool` が、`WorkerFactory` という 3 メソッドの抽象越しに Node の `worker_threads` とブラウザの Web Worker を同じに扱う（`parallel/node.ts` と `parallel/browser.ts`）。

- `parallel/protocol.ts` が境界の形を持つ。設定は構造化クローンできる値だけにし、スキルは実体ではなく ID で送って Worker 側が引き直す。結果は `Float64Array` に詰める。
- Node で `.ts` の Worker を起動するため `node-worker-bootstrap.mjs` が tsx の loader を登録してから本体を読む。Node の型剥がしはパラメータプロパティを扱えない。
- Worker が返事をせずに死ぬ経路（読み込み失敗、例外、メモリ不足）を `onError` で拾わないと、実行が永久に終わらない。

### solver

- `target.ts` / `critical.ts`：逆算。試行ごとに目標を満たす最小値（臨界値）を求め、その分布の分位点を必要値とする。`auto` は目標に応じて二分探索と全走査を選ぶ。
- `monotonicity.ts`：上の前提（1 試行の中で達成が単調）が成り立つかを測る検査器。
- `optimize.ts`：候補の差を同じ試行番号どうしの引き算で取る。
- `cost.ts`：表示されているスキルポイントは**そのスキルを持つまでの総額**である。同じグループからは 2 つ取らず、上位への乗り換えは差額になる。
- `screen.ts`：レース前に値が決まる条件だけを見て、走らせずに候補を落とす。**片側しか確かでない**。落としたものは確かに発動しないが、残ったものが発動するとは限らない。
- `candidates.ts`：育成計画（育成ウマ娘、デッキ、継承）から候補を組み立てる。入手経路ごとに縛りが違い、汎用の白は本数無制限、固有の継承版は 6 つまで。

### apps/web

`src/store.ts` が Zustand の単一ストアで、設定の保持だけでなく Worker の駆動も持つ（1000 行超。ここが事実上のアプリ本体）。
設定とスナップショットは IndexedDB（`persist.ts`）、共有は URL ハッシュ（`share.ts`）。サポートカードと育成ウマ娘のデータは数百 KB あるので、育成計画に切り替えたときに動的 import で取る。

`vite.config.ts` の自作プラグインが `skills.json` から未使用の項目を落とす。`assets/skills.json` 自体は本家のデータなので触らない。削った効果が黙って戻らないよう、`pnpm e2e` がバンドルの大きさに上限を置いている。

### apps/api

`http.ts` が手書きのルータで、`/api/health`、`/api/search`、`/api/ocr/skills`、`/api/ocr/status`、`/api/individuals` を持つ。
`config.ts` は並列数を決めるとき **cgroup の CPU クォータを直接読む**。`os.availableParallelism()` は Kubernetes の `limits.cpu` を見ないので、そのまま信じると Worker を立てすぎる。

設定はすべて環境変数である。`RACEEMU_CONCURRENCY`、`RACEEMU_MAX_RUNNING`、`RACEEMU_MAX_QUEUED`、`RACEEMU_MAX_RACES`、`RACEEMU_JOB_TTL_MS`、`RACEEMU_STATIC_ROOT`、`RACEEMU_TESSDATA`、`RACEEMU_MAX_IMAGE_BYTES`、`RACEEMU_OCR_THRESHOLD`、`RACEEMU_DATA_DIR`、`PORT`。
口の無い静的配信だけの版もあるので、UI 側は「JSON が返る前提」で書けない。`pnpm e2e` の偽サーバが HTML を返してそれを突く。

## 番人になっているテスト

- `packages/sim/test/reference.test.ts`：本家との突き合わせ。導出値は小数第 9 位まで一致、タイムは平均の差が標準誤差の 4 倍以内。参照値の作り直し手順は `packages/sim/test/golden/README.md`。
- `packages/sim/test/skill-coverage.test.ts`：未対応・近似扱いの条件型の集合を固定する。データに新しい型が増えるとここが落ちて気付ける。
- `test/workflows.test.ts`：ワークフローのパイプが `set -o pipefail` で失敗を握り潰していないかを見る。実際に取得失敗を緑にした事故がある。
