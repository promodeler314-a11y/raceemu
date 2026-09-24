# いまのデザイントークン一覧

`apps/web/src/index.css` の `@theme` と、`[data-theme='dark']` の差し替えに入っている値をそのまま並べたものである。
**これは現状の記録であって、こうあるべきという指針ではない。** 指針を作るときの出発点として使う。

> [#94](https://github.com/promodeler314-a11y/raceemu/pull/94) で、値は共有リポジトリの `design-system/tokens.css` に移った。名前は `--color-paper` から `--uma-paper` のように接頭辞が変わり、`index.css` は `@theme inline` で橋渡しするだけになった。値とユーティリティの名前（`bg-paper` など）は変えていないので、下の表の値と使用数はそのまま有効である。
>
> [#100](https://github.com/promodeler314-a11y/raceemu/pull/100) で、次の 3 つがこの表から変わった（DESIGN.md の 3〜4 節）。色の表のそのほかの値は変わっていない。
>
> - 書体：`--uma-font-sans` は BIZ UDPゴシック、`--uma-font-mono`（数値）は BIZ UDゴシック。BIZ UDPゴシックの数字は `tabular-nums` に対応していなかった
> - 太さ：`font-semibold` と `font-medium` は無くなり、`font-normal` と `font-bold` の 2 段になった
> - 主ボタン：`--uma-primary-bg` / `--uma-primary-fg` は強調色の朱 `--uma-accent`（明 `#b8391a`、暗 `#f07a52`）を指す。使い所は計算を走らせるボタンだけ

- 版：`ui-refresh` ブランチ、コミット `12e59a2`（[#94](https://github.com/promodeler314-a11y/raceemu/pull/94) の前）
- 対象：`apps/web/src/`（`.ts` `.tsx` `.css`）と `apps/web/index.html`
- Tailwind は v4.3.3 で、設定ファイルは無い。すべて `index.css` の `@theme` にある（`tailwind.config` も PostCSS の設定も置いていない）

## 数え方

「使われている箇所の数」は、次の 2 つを足した数である。

1. Tailwind のクラス（`bg-` `text-` `border-` `fill-` `stroke-` などの接頭辞に続けてトークン名を書いたもの。`hover:` などの変種も数える）
2. コードの中の `var(--color-…)`

`index.css` の定義そのものは数えていない。同じ行に 2 つ書いてあれば 2 と数える。

## 色トークン

| 名前 | 明 | 暗 | 主な用途 | 箇所 | 多い順の場所 |
| --- | --- | --- | --- | --- | --- |
| `--color-paper` | `#f5f4f1` | `#17181a` | ページの地。濃いボタンの上に載せる文字色（`text-paper`）にも使う | 9 | Field 3 / Import 2 / App 1 |
| `--color-surface` | `#fcfcfb` | `#1f2123` | ヘッダ・フッタ・カード・入力欄の面 | 33 | Inputs 8 / Field 6 / Shell 4 |
| `--color-sunken` | `#eeece7` | `#272a2d` | 一段落とした面。表の見出しの帯、カーソルを載せたときの色（`hover:bg-sunken` が 5 箇所）、コース形状の背景 | 14 | SkillList 3 / Inputs 2 / Notices 2 |
| `--color-rule` | `#dedbd3` | `#34373b` | 弱い罫線。表の行の区切り、見出しの下線 | 116 | Inputs 18 / Field 14 / SkillList 10 |
| `--color-rule2` | `#c6c2b8` | `#46494e` | 強い罫線。入力欄とカードの枠、区画の境 | 77 | Field 14 / Inputs 9 / Import 8 |
| `--color-ink` | `#12120f` | `#e9e7e2` | 本文の文字。濃いボタンの地（`bg-ink`） | 258 | Inputs 32 / SkillList 32 / Optimize 22 |
| `--color-ink2` | `#52514e` | `#aaa7a1` | 補助の文字。表の見出し、単位 | 35 | Shell 8 / Charts 7 / Inputs 7 |
| `--color-ink3` | `#8a877e` | `#77746e` | いちばん弱い文字。説明文、ラベル、注記 | 212 | SkillList 30 / Inputs 24 / Optimize 22 |
| `--color-s1` | `#2a78d6` | （同じ） | 強調の青。図の 1 列目、リンク、選択中のタブの下線、スキルの印、進捗のバー、着順の帯 | 11（クラス 8 ＋ `var()` 3） | Charts 3 / Shell 3 / Summary 2 |
| `--color-s2` | `#eb6834` | （同じ） | 比較の面の 2 列目の系列色 | 1（`var()` のみ） | Compare 1 |
| `--color-s3` | `#1baf7a` | （同じ） | 比較の面の 3 列目の系列色 | 1（`var()` のみ） | Compare 1 |
| `--color-acc-tint` | `#e7effa` | `rgba(58, 138, 232, 0.22)` | 選択中の地色（タブ、セグメント、逆算の「いまここ」の行） | 4 | Inputs 2 / Inverse 1 / Shell 1 |
| `--color-acc-ink` | `#1c5cab` | `#7fb2ea` | 選択中の文字と枠 | 6 | Inputs 3 / Inverse 1 / Shell 1 |
| `--color-primary-bg` | `#12120f` | `#e9e7e2` | 主ボタンの地 | 6 | Inputs / Inverse / Notices / Optimize ほか各 1 |
| `--color-primary-fg` | `#ffffff` | `#17181a` | 主ボタンの文字 | 6 | 同上 |
| `--color-warn-tint` | `#fdf6e3` | `rgba(232, 190, 80, 0.14)` | 注意の帯の地 | 7 | SkillList 3 / Optimize 1 / Plan 1 |
| `--color-warn-rule` | `#e8d9a8` | `#5c4d24` | 注意の帯の枠 | 7 | SkillList 3 / Optimize 1 / Plan 1 |
| `--color-warn-ink` | `#7a5c12` | `#d8bd6a` | 注意の文字。近似の印（△▲）にも使う | 14 | SkillList 4 / Fidelity 2 / Optimize 2 |
| `--color-bad-tint` | `#fdeceb` | `rgba(224, 108, 98, 0.14)` | エラーの帯の地 | 1 | Notices 1 |
| `--color-bad-rule` | `#f0c3bf` | `#6b3a36` | エラーの帯の枠 | 1 | Notices 1 |
| `--color-bad-ink` | `#a3312a` | `#e29a94` | エラーの文字 | 1 | Notices 1 |

色は 21 個ある。**`--color-s1` から `--color-s3` だけは、明と暗で同じ値である。** ほかの 18 個は暗で差し替えている。

### 気付いたこと

- **`s2` と `s3` は、比較の面の系列色（`Compare.tsx:83` の `SERIES_COLORS`）でしか使っていない。** 図の系列としては、`Charts.tsx` が同じ色を別に直書きしている（下の「トークンを使っていない色」を参照）
- **`bad-*` の 3 つは `Notices.tsx` のエラーの帯だけで使っている。** 入力の誤りや失敗した操作には使っていない
- **`hover:bg-surface2` が `Field.tsx:104` と `:138` にあるが、`--color-surface2` というトークンは無い。** そのため、この 2 箇所はカーソルを載せても色が変わらない（`docs/ui-audit-race-emulator.md` 第3節 C-3）
- 明の暗い側（`ink` `ink2` `ink3`）と、暗の明るい側（`paper` `surface` `sunken`）は、どちらも 3 段である。罫線は `rule` と `rule2` の 2 段

## 角丸

`@theme` に 3 つあるが、**値はすべて 3px で同じである。**

| 名前 | 値 | クラス | 使用数 |
| --- | --- | --- | --- |
| `--radius-sm` | `3px` | `rounded-sm` | 88 |
| `--radius-md` | `3px` | `rounded-md` | 0 |
| `--radius-lg` | `3px` | `rounded-lg` | 0 |

`rounded-full`（完全な丸）が 8 箇所ある。スキルのチップ（`Field.tsx:156`、`Optimize.tsx:201`、`Plan.tsx:225`、`SkillList.tsx:570`）、比較の面の系列の丸（`Compare.tsx:123`・`:223`）、結果の面の発動率のバー（`Summary.tsx:263`・`:265`）である。

## 文字

### フォント

| 名前 | 値 | 使い方 |
| --- | --- | --- |
| `--font-sans` | `'IBM Plex Sans JP', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif` | `body` に指定（`index.css:78`）。画面の既定 |
| `--font-mono` | `'IBM Plex Mono', ui-monospace, Consolas, monospace` | `.num` クラス（`index.css:88`、`font-variant-numeric: tabular-nums` つき）と `font-mono` クラス |

- `.num` が 59 箇所、`font-mono` が 19 箇所、`tabular-nums` が 53 箇所である
- IBM Plex の 2 書体は Google Fonts から読んでいる（`index.html:18-23`）。ページを開くたびに外部へ取りに行く
- `index.css:2` で uPlot の既定 CSS を読み込んでいる。**グラフの見出しと凡例だけは、この土台に載っていない**（`system-ui, -apple-system, "Segoe UI", …` になる）

### 大きさ

`body` の既定は `font-size: 13px` / `line-height: 1.5`（`index.css:79-80`）である。クラスの内訳は次のとおり。

| クラス | 実際の大きさ | 使用数 | 主な用途 |
| --- | --- | --- | --- |
| `text-xs` | 12px | 208 | 画面のほとんど。説明文、表の中身、ボタン |
| `text-sm` | 14px | 62 | 区画の中の見出し、主ボタン、入力欄 |
| `text-[11px]` | 11px | 23 | 注記、フッタ、イベントの種別 |
| `text-[13px]` | 13px | 7 | カードの見出し（`Panel`）、タブ |
| `text-lg` | 18px | 6 | 結果のタイル（最速・最遅など）の数値 |
| `text-base` | 16px | 1 | エラー画面の見出し |
| `text-4xl` | 36px | 1 | 結果の平均タイム |

段は 7 つあるが、11px と 13px だけ任意の値（`[…]`）で書いていて、ほかは Tailwind の既定の段を使っている。

### 太さ

`font-normal` 69、`font-semibold` 40、`font-medium` 7。太さは 3 段である。

## 余白

余白のトークンは定義していない。Tailwind の既定の刻み（1 = 0.25rem = 4px）をそのまま使う。多い順に並べると次のとおり。

| 値 | 実寸 | 出現数 | 主な使い方 |
| --- | --- | --- | --- |
| `1` | 4px | 246 | 表のセルの上下（`py-1` が 110）、見出しの下（`pb-1` が 48） |
| `2` | 8px | 174 | 表のセルの左右（`pr-2` `px-2`）、区画の中の間隔（`mt-2` が 45） |
| `3` | 12px | 133 | 入力欄の並びの間隔（`gap-3` が 27）、ボタンの左右（`px-3` が 27） |
| `1.5` | 6px | 41 | ボタンの上下（`py-1.5` が 29） |
| `4` | 16px | 37 | 区画どうしの間隔 |
| `0.5` | 2px | 30 | チップの上下（`py-0.5` が 21） |
| `5` | 20px | 8 | 面の外周（`p-5`、左右 `px-5`） |
| `2.5` | 10px | 5 | 設定の列の項目の間隔（`gap-2.5`） |
| `3.5` | 14px | 1 | 設定の列全体の間隔（`gap-3.5`） |
| `20` | 80px | 1 | 未実行のときの上下の空き（`py-20`） |

**幅と高さには任意の値が 12 箇所ある。** `w-[468px]`（設定の列）と `w-[280px]`（左の要約）は `App.tsx` に、`h-[30px]` `h-[34px]`（ボタンの高さ）は 5 箇所にある。表の最小幅（`min-w-[36rem]` `min-w-[34rem]` `min-w-[30rem]` `min-w-[28rem]` `min-w-[26rem]` `min-w-[24rem]` `min-w-[16rem]`）は面ごとにばらばらである。

## トークンを使っていない色

**グラフだけがトークンの外にある。** `canvas` に描く uPlot は CSS の変数をそのまま渡せないため、JavaScript 側で値を選んでいる。SVG のタイム分布も同じ書き方に揃えてある。

| 場所 | 値（明 → 暗） | 何の色か | 対応するトークン |
| --- | --- | --- | --- |
| `Charts.tsx:18` | `#2a78d6` → `#3987e5` | 図の系列「速度」 | 明は `s1` と同じ。暗は対応するトークンが無い |
| `Charts.tsx:19` | `#eb6834` → `#d95926` | 図の系列「残り体力」 | 明は `s2` と同じ。暗は対応するトークンが無い |
| `Charts.tsx:21` | `#52514e` → `#c3c2b7` | 目標速度と勾配（文脈の線） | 明は `ink2` と同じ。**暗の `#c3c2b7` は `ink2` の暗（`#aaa7a1`）と違う** |
| `Charts.tsx:14` | `#1baf7a` | コメントの中（`s3` の値についての注記） | `s3` |
| `Charts.tsx:225-226` | 軸 `#52514e` → `#c3c2b7`、グリッド `#eceae4` → `#2a2a28` | uPlot の軸とグリッド | 軸は上と同じ。グリッドはどちらもトークンに無い値 |
| `Charts.tsx:109` | `rgba(0,0,0,0.045)` → `rgba(255,255,255,0.05)` | コーナーの帯 | 無し（黒／白の薄い重ね） |
| `Charts.tsx:115` | `rgba(0,0,0,0.18)` → `rgba(255,255,255,0.22)` | フェーズの境の破線 | 無し |
| `Charts.tsx:583` | `#8a877e` → `#77746e` | タイム分布の p5・p50・p95 の破線 | `ink3` と同じ値を直書き |
| `Charts.tsx:593` | `#c6c2b8` → `#46494e` | タイム分布の底の線 | `rule2` と同じ値を直書き |
| `MultiRace.tsx:23` | `rgba(82,81,78,0.45)` → `rgba(195,194,183,0.5)` | 全頭同時の図の、自分と 1 着以外の線 | 無し（`ink2` を薄くした値に近い） |

トークンを読んでいるのは次の 3 箇所だけである。

- `Charts.tsx:125`：スキルの印の色。`tokenColor('s1')` が `getComputedStyle` で `--color-s1` を読む（`Charts.tsx:38-40`）
- `Compare.tsx:83`：比較の系列色。`var(--color-s1)` `var(--color-s2)` `var(--color-s3)` をそのまま書く
- `Field.tsx:382`：着順の帯。`color-mix(in srgb, var(--color-s1) …%, transparent)` で濃さを変える

### この持ち方から起きていること

- **トークンを変えてもグラフには反映されない。** 明の値は `s1` `s2` `ink2` `ink3` `rule2` と一致するので、いまは見た目が揃っているだけである
- **暗の軸の色だけ、対応するトークンとずれている**（`#c3c2b7` と `#aaa7a1`）
- `isDark()`（`Charts.tsx:29`）が `<html data-theme>` を読んで明暗を選ぶ。この関数は 9 箇所から呼ばれている。**uPlot は図を作るときに一度だけ読むので、テーマを切り替えても表示中の図は色が変わらない**（`docs/ui-audit-race-emulator.md` 第3節 A-1）
