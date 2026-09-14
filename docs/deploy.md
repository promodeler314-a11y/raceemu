# 配信

`apps/web` が出す静的ファイルと `apps/api` を、自前の k3s に置く（4 節）。
`apps/api` は静的ファイルも同じオリジンから配るので、これ一つでアプリとして完結する。

GitHub Pages への配信は廃止した（5 節）。

## 1. 静的ファイルだけで足りる

`pnpm build` が出すのは `apps/web/dist` の 4 ファイルで、サーバ側の処理は要らない。

| ファイル | 大きさ |
| --- | ---: |
| `index.html` | 1.83 kB（gzip 1.09 kB） |
| `assets/index-*.css` | 20.1 kB（gzip 5.09 kB） |
| `assets/index-*.js` | 1.59 MB（gzip 258 kB） |
| `assets/browser-worker-*.js` | 1.18 MB |

面倒になりがちな条件が四つとも外れている。

- **サブパスで配れる。** `base: './'` にしてあるので参照が相対になり、`/raceemu/` の下でもそのまま動く。
  末尾の `/` が無い状態（`/raceemu`）で入ると、資産の相対参照が親の階層から解決されてしまい真っ白になる。
  これは `index.html` の先頭のスクリプトで先に付け直すようにしてある。
  また、手前の reverse proxy が接頭辞を外さずに転送してくる場合に備え、`apps/api` の静的配信（`serveStatic`、`http.ts`）は先頭の 1 段を外した経路でも資産を探す。
- **404 のフォールバックが要らない。** 共有 URL はハッシュ（`store.ts` の `shareUrl`）で表しており、History API を使っていない。
- **COOP/COEP を送らなくてよい。** `SharedArrayBuffer` を使っていないので、Worker は普通の配信で動く。
- **ソースが同じ場所にある。** リポジトリは公開で、フッタのリンク（`App.tsx`）が解決する。AGPL v3 の下で配る前提を満たす。

したがってホストの乗り換えは安い。
成果物は配信先に依存していない。

## 2. 取り込む前に検査する

[ワークフロー](../.github/workflows/ci.yml)は `typecheck`、`test`、`build`、`e2e` の順に走らせる。
`main` と pull request の両方で走り、配信とは切り離してある。

`e2e` を外さないのは、これがビルドした成果物を実際に配信してブラウザで叩く唯一の段だからである。
バンドルの上限、フッタのソースリンク、名前のないボタンの数、幅 390 での横あふれは、ここでしか見ていない。
単体テストは計算モデルを見ているので、配るものが壊れていることは検出しない。

ランナーにブラウザ本体は入っていないため、`playwright install` を挟む。

ランナーは手元より遅い。
テストは実際にレースを回すので 1 件で数秒から数十秒かかり、vitest の既定の 5 秒では足りない。
[設定](../vitest.config.ts)で 120 秒にしてある。
`smoke.mjs` は、開発コンテナに置いてある Chromium があればそれを使い、無ければ Playwright に探させる。

## 3. 見ておくこと

- **モバイルでの Worker 数。** 既定は `hardwareConcurrency - 1`（`packages/sim/src/parallel/browser.ts`）なので、8 コアの端末では 7 本立ち上がり、それぞれ 1.18 MB を読む。上限を切るかは実機で測ってから決める。
- **ES module 形式の Worker。** `vite.config.ts` で `worker.format` を `es` にしている。Firefox は 114 から対応した。
- **入れ替えの反映。** タグが `main` のまま中身が変わるので、`kubectl apply` では新しいイメージに変わらない（4.2 節）。

## 4. 自前の k3s に置く

[探索・画面の読み取り・個体の保存](server-design.md)をサーバ側で回すための置き場である。
静的ファイルも `apps/api` が同じオリジンから配る。

### 4.1 イメージ

[ワークフロー](../.github/workflows/image.yml)が `main` への取り込みごとに `ghcr.io/promodeler314-a11y/raceemu` を更新する。
タグは `main` と `sha-<短縮>` の 2 つで、常用は `main`、動いている版を固定したいときは `sha` を指す。

手元で組んで転送する手順は置いていない。
挟むと、何が動いているのかがコミットから追えなくなる。

pull request では組むだけで置かない。
`Dockerfile` が壊れていることにマージしてから気付く、という事故をここで止める。

**パッケージは公開で置かれる。**
最初の 1 本を置いたあと、資格情報なしで引けることを確かめた。

```
$ curl -s "https://ghcr.io/token?scope=repository:promodeler314-a11y/raceemu:pull&service=ghcr.io" | jq -r .token > /tmp/t
$ curl -s -H "Authorization: Bearer $(cat /tmp/t)" https://ghcr.io/v2/promodeler314-a11y/raceemu/tags/list
{"name":"promodeler314-a11y/raceemu","tags":["main","sha-c8f79e6"]}
```

クラスタ側に `imagePullSecret` は要らない。
非公開にしたくなった場合は、パッケージの設定で切り替えたうえで、`ghcr.io` を引ける `imagePullSecret` を作って `deploy/k8s.yaml` の `spec.template.spec` に足す。

**組んでいるのは `linux/amd64` だけである。**
ノードが arm64 なら引けない。
そのときはワークフローの `build-push-action` に `platforms: linux/amd64,linux/arm64` を足す。
組む時間は倍以上になる（QEMU を挟むため）ので、要ると分かってから足す。

### 4.2 置く

```
kubectl apply -f deploy/k8s.yaml
kubectl rollout status deploy/raceemu -n raceemu
kubectl port-forward deploy/raceemu 8080:8080 -n raceemu   # 手元から確かめる
curl -s localhost:8080/api/health
```

マニフェストは `raceemu` という名前空間を作ってその中に置く。
名前空間を指定しないと、`kubectl apply` を実行した人の現在のコンテキストの名前空間にそのまま入ってしまい、次の 4.3 節で使う Service の DNS 名が人によって変わってしまう。

`/api/health` が返す `concurrencySource` が `cgroup` であれば、[設計](server-design.md)の 4.1 節の前提どおりに並列数を読めている。
`availableParallelism` と出ていたらクォータを読めておらず、ノードのコア数で走っている。
`RACEEMU_CONCURRENCY` を置いて明示する。

新しいイメージに入れ替えるときは次のとおりである。
タグが同じ `main` のままなので、`apply` では何も変わらない。

```
kubectl rollout restart deploy/raceemu -n raceemu
```

### 4.3 外に出す

Service（`raceemu.raceemu.svc.cluster.local:80`）を cloudflared の宛先にする。
Ingress は要らない。

トンネルをリモート管理（`cloudflared tunnel run --token ...`）で立てている場合、宛先の設定はクラスタ内ではなく Cloudflare のダッシュボード（Zero Trust → Networks → Tunnels → 該当のトンネル → Public Hostname）にある。
Service の URL 欄にはスキーム（`http://`）を付けず、ホスト名とポートだけを入れる。
Type を別に選ぶ欄がある。

**認証は持たせていない。**
[設計](server-design.md)の 5 節のとおり、Cloudflare Access を前に置く前提である。
探索は 1 本で 25 万レース規模になるので、誰でも投げられる状態で外に出すと、そのまま計算資源を配ることになる。

## 5. GitHub Pages への配信をやめた

`https://promodeler314-a11y.github.io/raceemu/` に配っていたが、廃止した。
配信のワークフロー（`pages.yml`）は検査だけを残して `ci.yml` に改めてある。

置き場が一つ減っただけで、ビルドした成果物の性質は変わらない（1 節）。
どこかの静的配信に置けば計算はブラウザで回る。
ただし画面の読み取り（`/api/ocr/*`）と個体の保存（`/api/individuals`）は `apps/api` が要るので、静的配信だけの版では使えない。

**静的配信だけの版を想定した扱いは残してある。**
アプリは `/api` を叩いてみて、応答が JSON かどうかで口の有無を判断する（[読み取り](ocr-design.md)の 1 節）。
`pnpm e2e` の静的サーバも POST に 405 と HTML を返す形のままで、口が無いことを画面で伝えているかをここで見ている。

## 6. スキル一覧の表を配る

[スキル一覧](https://github.com/promodeler314-a11y/raceemu/issues/83)は、全スキルの単体評価を事前に計算した表である。
ブラウザでは回らない量なので、計算した結果を**静的なファイルとして配り、画面は動的に取る**。
形は `packages/solver/src/skill-list.ts`、生成は `packages/solver/src/skill-list-cli.ts`（`pnpm skill-list`）にある。

この節は、その表を**どう配り、いつ作り直し、何世代残すか**を決める。

### 6.1 置き場は `apps/web/public/skill-list/<版>.json`

`apps/web/public` は Vite が中身をそのまま `dist` に写す場所である。
**バンドルには入らない。**
`import` していないので依存の木に載らず、`vite.config.ts` の `trimSkillData` も通らない。
`pnpm build` の後、`dist/skill-list/<版>.json` として出る。

これは 1 節の表に載っている 4 ファイルの外側にあり、`pnpm e2e` のバンドル上限（`assets/index-*` と `assets/browser-worker-*` の大きさ）にも影響しない。
逆に言うと、うっかり `import` に変えるとバンドルが数 MB 太るので、`e2e` のほうで落ちる。

`apps/api` の静的配信（`http.ts` の `serveStatic`）は `RACEEMU_STATIC_ROOT`（イメージでは `/app/apps/web/dist`）の下をそのまま返すので、同じ `/skill-list/<版>.json` で取れる。
`deploy/Dockerfile` は `apps/` を丸ごと写してから `pnpm build` するため、イメージにも一緒に入る。

**版がパスに入っているので、キャッシュは不変にしてよい。**
`serveStatic` は `public, max-age=31536000, immutable` を付ける。
中身が変われば版が変わり、版が変われば名前が変わるので、古いものを掴んだままになることはない。

**ただし入口だけは別である。**
読む側は版を当てられない（版はデータと計算式と相手の分布の指紋から決まるので、画面がファイル名を組み立てることはできない）ので、名前を教える 1 枚 `skill-list/index.json` をあいだに置いている（`SkillListIndex`）。
これは**名前が変わらないまま中身が入れ替わる**唯一のファイルで、不変として配ると新しい版を置いても画面が古い名前を取りに行き続ける。
版がパスに入っている効き目が、入口のところで消えてしまう。
`index.html` と同じ扱い（`no-cache`）にしてある。
`serveStatic` は拡張子ではなくファイル名で見分けており、そのための一覧が `REVALIDATE_NAMES` である。

大きさのために 2 つ手当てをしてある。

- **64 kB を超える JSON/JS/CSS/SVG は、その場で gzip に掛けて出す。**
  表は数 MB あり、縮めずに出すとこれだけで他の資産の合計より大きくなる。
  数字の並びなので、いちばん弱い段（level 1）でも 10 分の 1 以下になる。
  段を弱くしてあるのは、圧縮が探索の Worker と同じコアを使うためである。
- **無い版は `index.html` ではなく 404 で返す。**
  それまでは見つからない経路をすべて `index.html` に落としていた（1 節の「404 のフォールバック」）。
  データを求める経路でこれをやると、**HTML が 200 で返り、読む側は `JSON.parse` が投げるまで気付けない。**
  版を取り違えたのか配り忘れたのかも区別できなくなる。
  拡張子が `.json` の要求だけフォールバックから外してある。

### 6.2 材料が動いた回だけ作り直す

版は `SkillListDataset` の 4 つ、すなわち `skills.json`・`courses.json`・`race-manifest.json`・相手の束の作り方（`defaultFieldProfile`）で決まる。
**どれも動いていない回に回しても、同じ値を何時間もかけて作り直すだけになる。**

そこで [`build-skill-list.yml`](../.github/workflows/build-skill-list.yml) は **`schedule` を持たない。**
`main` でその 4 つのどれかが動いた `push` で起きる。

既存の 3 本が週次なのは、**本家が動いたかどうかは取りに行かないと分からない**からである。
こちらの材料は 4 つとも自分のリポジトリの中にあり、動いたことは `push` で分かる。
同じ理由で `paths:` のフィルタが「何が動いたか」の判定そのものになり、指紋を二重に持たなくて済む。

### 6.3 既存の 3 本との順序

3 本はどれも**下書き PR を出すところまで**で、`main` に入るのは人がマージしたときである。
したがって `build-skill-list` は必ずそのマージの後に走り、並んで走ることはない。

| 動いたもの | 起こす PR | 表の作り直し |
| --- | --- | --- |
| `skills.json` / `courses.json` | `sync-game-data` | マージされた時点で走る |
| 本家の `race` モジュール | `check-race-model` | マージされた時点で走る |
| 相手の束の作り方 | （人の PR） | マージされた時点で走る |
| スキル分類モデル | `sync-skill-model` | 走らない（読み取り用で、表の値に関わらない） |

`check-race-model` との順序は特に大事である。
CLAUDE.md のとおり、**この PR のマージは「移植を追随させた」という宣言**なので、表が作り直される時点で `packages/sim` は既に新しい本家に合っている。
先に表だけを作り直して古い計算式の値を配ることにはならない。

**逆向きの穴が一つある。**
本家が動いていないのに移植側だけを直した回（こちらのバグ取り）は、指紋が動かないので何も起きない。
このときは `workflow_dispatch` に `force` を付けて手で回す。
`force` は「版が変わらなくても PR を出す」という意味で、付けないと生成時刻だけが違う差分を捨てて緑で終わる（中身の変わらない PR を毎回出さないため）。

### 6.4 時間の上限には収まる。ただし全コースは無理

GitHub Actions の 1 ジョブの上限は 6 時間である。

いまの範囲（距離帯ごとの代表コース）の見積もりが 4 コアで約 71 分。
`ubuntu-latest` の標準ランナーは 4 vCPU だが、手元より 1.5〜2 倍遅いと見て 2〜2.5 時間になる。
上限の半分以下なので**現実的である。**
意図を残すため `timeout-minutes: 240` で切ってある（既定の 360 分のまま放置すると、暴走したときに上限いっぱいまで回る）。

**コース 137 本すべてに広げると収まらない。**
issue #83 の見積もり（2116 スキル × 137 コース × 脚質 4 × 基準 2）は、代表コース数本の場合の 15 倍以上ある。
`screen.ts` で落ちる分を引いても 6 時間には入らない。
広げるときは次のどちらかになる。

- **`matrix` で距離帯ごとに 4 ジョブに分け、最後に 1 つの JSON に畳む。** 1 ジョブあたりは 4 分の 1 になる。畳む段が増えるぶん、部分的な失敗の扱いを決める必要がある。
- **自前のランナーに移す。** 4.2 節の k3s と同じ機械で回せば時間の上限そのものが無くなる。

どちらも「代表コースで動いてから」でよいので、いまは広げていない。

### 6.5 リポジトリには 2 世代だけ残す

版がパスに入るので、作り直すたびにファイルが増える。
ワークフローは新しいものから数えて 2 世代だけを残し、それより古いものを同じ PR で消す。

**2 である理由。**

- 1 では足りない。入れ替えの最中、すでに開いている画面は古い `index.html` と古い版の名前を持っている。新しい版に差し替えた瞬間に古い版を消すと、その画面は 404 を引く。1 世代の猶予があれば、次の入れ替えまでに読み直される。
- 3 以上に意味が無い。表は「いまの材料での値」であって、過去の版を並べて比べる使い方をしない（比べたいのは本家の版どうしであって、それは `race-manifest.json` の履歴が持っている）。

**掃除は `index.json` と一緒に直さないと意味がない。**
消した版の名前が `generations` に残ると、画面は取りに行って初めて 404 を引く。
`index.json` は正しい JSON のままなので、**食い違っても誰も落ちない。**
表が出ないのがネットワークのせいなのか配り方のせいなのかも区別が付かなくなる。

そこで掃除そのものを [`scripts/prune-skill-list.mjs`](../scripts/prune-skill-list.mjs) に出し、消したあとで `generations` を実際に残ったものに書き直させている。
ワークフローのシェルに直接書かないのは、**手元で動かして食い違いを試せる所に置きたい**からである（`test/workflows.test.ts` が実際に走らせている）。
決めごとは 3 つある。

- **`index.json` は版ではない。** 掃除の対象から外す。`.json` を並べて数えると、版として落ちるか、いちばん古いものとして最初に消える。
- **`latest` が指す版は、残す世代数によらず必ず残す。** 並びの先頭に固定してから数える。版が変わらなかった回に `force` で作り直すと、`latest` の commit の時刻がいちばん古い側に来ることがありうる。
- **`latest` が指す版が無ければ赤で落とす。** そのまま配ると画面が 404 を引く。掃除で消えた場合も、CLI が食い違ったものを書いた場合も、同じところで止まる。

並びは `git log -1 --format=%ct` で測った commit の時刻で決める。
checkout した直後はファイルの更新時刻が全部同じになるので、ファイルシステムからは決まらない。
今回作ったものはまだ commit されていないため行が出ず、いちばん新しいものとして扱われる。

**消しても軽くならないことは承知の上である。**
git は消しても履歴に残るので、作り直した回数ぶんの数 MB は clone に永久に載る。
本家の版が 2〜4 週ごとであることを考えると、年に 10〜25 回、数十 MB から 100 MB ほど積む。
それでも当面はリポジトリに置く。
静的配信のホストを何も足さずに済み、`deploy/Dockerfile` が `apps/` を写すだけで配れるからである（6.1 節）。

**重くなってきたら、配り方のほうを変える。**
表をリポジトリから外して GitHub Release の添付か `ghcr.io` の別レイヤに置き、画面はそちらを取りに行く形になる。
そのときは同一オリジンでなくなるので CORS が要る（[サーバ側の設計](server-design.md)の 5 節）。
先にやらないのは、**まだ何 MB になるか実測していない**からである。
代表コースで一度作って、`git count-objects -vH` の伸びを見てから決める。
