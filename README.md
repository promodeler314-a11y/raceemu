# raceemu

ウマ娘レースエミュレータ（https://mee1080.github.io/umasim/race/）の調査と、それをもとにした改良版 Web アプリである。

本家の計算モデルを TypeScript に移植したうえで、並列実行、統計、設定どうしの比較、目標からの逆算、スキルの組み合わせ探索を載せてある。
計算はブラウザの Worker で回るので、サーバを立てなくても動く。

## 配信

https://promodeler314-a11y.github.io/raceemu/

`main` に入ると[ワークフロー](.github/workflows/pages.yml)が `typecheck`、`test`、`build`、`e2e` を通してから配る。
詳しくは[配信](docs/deploy.md)を参照。

## 画面

- **設定**：ステータス、コース、脚質、やる気、バ場状態、所持スキル、デバフ、実行オプション。補正後の値とコース形状を併せて出す。
- **結果**：平均タイム、完走率、最速と最遅、ゴール時の残り体力、タイムの分布、スキル別の発動状況。発動条件を確率で近似しているスキルには印を付ける。
- **比較**：保存したスナップショットを列に並べる。基準の列を選べて、差のある項目だけに畳める。分布を重ねられる。
- **詳細**：1 レースの速度と体力の推移と、スキル発動やフェーズ境界を拾ったイベント一覧。
- **探索**：目標から必要なステータスを求める逆算と、スキルポイントの予算内で最良の組み合わせを探す探索。

設定とスナップショットは IndexedDB に残る。
設定は URL のハッシュに載せて共有できる。
ライトとダークを切り替えられる。

自前の Kubernetes に置いて探索をサーバ側で回す口も用意してある（[設計](docs/server-design.md)）。

## 開発

```
pnpm install
pnpm test        # 本家との突き合わせとスキル条件の網羅。8 ファイル 73 件
pnpm typecheck
pnpm sim --count 1000 --location 10006 --course 10606
pnpm bench --count 10000       # 並列実行の実測
pnpm dev                       # UI の開発サーバ
pnpm build                     # UI のビルド
pnpm e2e                       # ビルドした UI を実際のブラウザで確認
pnpm monotonicity --trials 60  # 逆算の前提（単調性）の検査
pnpm optimize --budget 600 --style SEN  # 組み合わせ探索の実測
pnpm api                       # 探索をサーバ側で回す口（apps/api）
```

## 構成

`packages/sim` が計算モデル、`packages/data` がコースデータとスキルデータ、`packages/solver` が逆算と探索、`apps/web` が UI、`apps/api` が探索をサーバ側で回す口である。
`deploy/` に Dockerfile と Kubernetes のマニフェストを、`design/` に画面モックを置いてある。
計算モデルは [mee1080/umasim](https://github.com/mee1080/umasim) からの移植であり、本リポジトリも AGPL v3 とする。

## 設計と解析

- [ウマ娘レースエミュレータ（mee1080/umasim）の解析](docs/race-emulator-analysis.md)
- [レースエミュレータ改良版の設計](docs/webapp-design.md)
- [逆算と組み合わせ探索の設計](docs/solver-design.md)
- [順位条件の扱い](docs/order-condition.md)
- [配信](docs/deploy.md)
- [サーバ側で探索を回す設計](docs/server-design.md)
- [画面モック](design/README.md)と[モックと実装のズレ](docs/ui-gap.md)

## これまでの回

| 回 | 入れたもの |
| --- | --- |
| [M1](docs/m1-report.md) | 計算モデルの移植と、本家との突き合わせ |
| [M2](docs/m2-report.md) | Worker プールでの並列実行と集計 |
| [M3](docs/m3-report.md) | UI の骨格。設定を入れて実行し、1 レースの中身を見るところまで |
| [M4](docs/m4-report.md) | スナップショットの比較、URL での共有、スキルごとの集計 |
| [M5](docs/m5-report.md) | 目標からの逆算 |
| [M6](docs/m6-report.md) | フィールド軌跡モデル。順位条件を判定できるようにした |
| [M7](docs/m7-report.md) | スキルの組み合わせ探索 |
| [M8](docs/m8-report.md) | 積み残しの整理。順位に関わる条件を 187 回ぶん足した |

M8 の後は回として分けていない。
GitHub Pages への配信、探索をサーバ側で回す口、画面をモックに寄せる作業をこの順で入れた。
最後のもので色のトークン、ヘッダとタブ、プリセット、イベント一覧、比較の作り直しが入り、モックへの寄せが一巡している。

## 残っていること

- **順位に関わる条件のうち 122 回ぶん。** レーンに関わるものと周囲の頭数であり、相手のレーンを持っていないと判定できない（[M8](docs/m8-report.md) の 8 節）。
- **バ身を 2.5 m とした換算と、相対位置の定義。** スキルデータの注記からの読み取りであって、ゲーム内での実測ではない。
- **中断からの再開。** 途中までの結果は残すようにしたが、塊が順不同で終わるため埋まっていない試行番号が飛び飛びに残り、1 つの再開位置では表せない。
- **本家エミュレータの設定の読み込み。** 本家がどの形式で設定を渡すのかが分かっていない。
- **サーバ側の残り。** ポッドの中での並列数の実測、アプリから宛先を選ぶ口、候補スキルの全件化（[サーバ側で探索を回す設計](docs/server-design.md)の 8 節）。
