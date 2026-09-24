# 配信

`apps/web` が出す静的ファイルと `apps/api` を、自前の k3s に置く（4 節）。
`apps/api` は静的ファイルも同じオリジンから配るので、これ一つでアプリとして完結する。

**`main` に入れれば、数分（遅くとも 10 分ほど）で本番に出る。人が手で入れ替える手順は無い。**
クラスタの中の CronJob が 5 分ごとに `main` を見に行き、新しいコミットがあればクラスタの中で組んで入れ替える（4.2 節）。

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
- **入れ替えのたびに Pod が作り直される。** `main` に何か入るたびに再起動するので、実行中の探索はそこで切れる。保存した個体は PVC に置いてあるので残る（4.3 節）。

## 4. 自前の k3s に置く

[探索・画面の読み取り・個体の保存](server-design.md)をサーバ側で回すための置き場である。
静的ファイルも `apps/api` が同じオリジンから配る。

**この節は、動いているクラスタから読み取った実態を書いている（2026-09-24 時点）。**
入れ替えの仕組み（4.2 節）とゲートウェイ（4.4 節）のマニフェストはリポジトリに無く、クラスタにだけある。
`deploy/k8s.yaml` も本番とは食い違っている（4.3 節）。
クラスタを作り直すときは、ここに書いたものを `kubectl get -o yaml` で取っておいてから始める。

全体の流れは次のとおりである。

```
main に push
  └→ raceemu-sync（CronJob、5 分ごと）が GitHub から main の SHA を取る
       └→ デプロイ済みの SHA と違えば raceemu-build（Job）をその場で作る
            └→ BuildKit が GitHub から直に組み、192.168.0.203:5000/raceemu に置く
                 └→ rollout restart → 立ち上がったら SHA の印を付け替える

利用者 → Cloudflare → raceemu-gate（マジックリンク）→ raceemu（apps/api）
```

### 4.1 イメージは 2 か所で組まれている

**本番が引いているのは、クラスタの中で組んだほうである。**

| | クラスタの中（本番） | GitHub Actions |
| --- | --- | --- |
| 組む所 | `raceemu-build` Job（BuildKit、rootless） | [`image.yml`](../.github/workflows/image.yml) |
| 置き場 | `192.168.0.203:5000/raceemu`（LAN のレジストリ、平文の HTTP） | `ghcr.io/promodeler314-a11y/raceemu` |
| タグ | 短縮 SHA（例 `c40450f`）と `current` | `sha-<短縮>` と `main` |
| 本番が引くか | 引く（`:current`） | 引かない |

どちらも同じ `deploy/Dockerfile` から組む。

**`image.yml` を残しているのは、pull request で `Dockerfile` を検査するためである。**
pull request では組むだけで置かない。
`Dockerfile` が壊れていることにマージしてから気付く、という事故をここで止める。
`main` では ghcr.io にも置くが、本番はそれを使っていない。

**手元で組んで転送する手順は置いていない。**
挟むと、何が動いているのかがコミットから追えなくなる。
クラスタの中で組むときも、組む元は GitHub 上のその SHA（`https://github.com/promodeler314-a11y/raceemu.git#<SHA>`）であり、手元の作業ツリーではない。
タグにも短縮 SHA が付くので、レジストリを見れば何が組まれたか分かる。

**BuildKit は GitHub から直に取るので、`design-system` も公開のまま取れる必要がある。**
submodule の中身も BuildKit が取りに行く。
[uma-design-system](https://github.com/promodeler314-a11y/uma-design-system) を非公開にすると、GitHub Actions は `DS_PAT` で通るが、クラスタの中のビルドは資格情報を持っていないので止まる。

**ghcr.io のイメージは `linux/amd64` だけである。**
本番には関係しない（クラスタの中のビルドはノードと同じ形で組まれる）。
ghcr.io のイメージを arm64 のノードで使うことになったら、`build-push-action` に `platforms: linux/amd64,linux/arm64` を足す。
組む時間は倍以上になる（QEMU を挟むため）ので、要ると分かってから足す。

ghcr.io のパッケージは公開で、資格情報なしで引けることを確かめてある。

```
$ curl -s "https://ghcr.io/token?scope=repository:promodeler314-a11y/raceemu:pull&service=ghcr.io" | jq -r .token > /tmp/t
$ curl -s -H "Authorization: Bearer $(cat /tmp/t)" https://ghcr.io/v2/promodeler314-a11y/raceemu/tags/list
```

### 4.2 入れ替えは CronJob が自動でやる

名前空間 `raceemu` に次のものが置いてある。

| 種類 | 名前 | 役目 |
| --- | --- | --- |
| CronJob | `raceemu-sync` | 5 分ごとに `sync.sh` を走らせる（`alpine/kubectl`） |
| ConfigMap | `raceemu-sync` | `sync.sh` と `build-job.yaml`（ビルド Job の雛形） |
| ServiceAccount / Role / RoleBinding | `raceemu-deployer` | Job の作成と削除、Deployment の更新、Pod のログの読み取りだけを許す |
| Job | `raceemu-build` | 1 回ごとのビルド。`sync.sh` が雛形から作る |

`sync.sh` がやることは次のとおりである。

1. GitHub の API で `main` の先頭の SHA を取る。40 桁の 16 進でなければ（エラーの JSON が返った場合など）そこで止める。
2. Deployment `raceemu` の注釈 `raceemu.dev/commit` と比べる。同じなら何もせずに終わる（「変更なし」）。
3. 前回の `raceemu-build` Job を消し、雛形の SHA を埋めて作り直す。BuildKit が組んで、`:<短縮 SHA>` と `:current` の 2 つのタグで置く。ビルドのキャッシュも同じレジストリの `:buildcache` に置く。
4. 15 秒おきに Job を見て、終わるのを待つ（30 分で打ち切る）。
5. `kubectl rollout restart` で入れ替え、`rollout status` で立ち上がりを待つ。Deployment は `imagePullPolicy: Always` なので、`:current` を引き直す。
6. **立ち上がったあとで**注釈 `raceemu.dev/commit` を新しい SHA に書き換える。

**印を最後に付けるので、途中で失敗しても次の回にやり直しになる。**
ビルドに失敗しても入れ替えが終わらなくても、注釈は古い SHA のままなので、5 分後の回がもう一度組む。
CronJob は `concurrencyPolicy: Forbid` で、前の回が組んでいる最中に次の回が重ならない。

**いまの版を見る。**

```
kubectl get deploy raceemu -n raceemu -o jsonpath='{.metadata.annotations.raceemu\.dev/commit}'
kubectl get jobs -n raceemu                      # 同期の回ごとの成否と、直近のビルド
kubectl logs job/raceemu-build -n raceemu         # ビルドのログ（終わってから 1 日残る）
```

**待たずに入れ替える。** 5 分を待てないときは、CronJob から Job を 1 本作る。

```
kubectl create job --from=cronjob/raceemu-sync raceemu-sync-manual -n raceemu
kubectl logs -f job/raceemu-sync-manual -n raceemu
```

**版を止める、戻す。**
`sync.sh` は `main` の先頭に揃えようとするので、先に CronJob を止めてからイメージを指す。

```
kubectl patch cronjob raceemu-sync -n raceemu -p '{"spec":{"suspend":true}}'
kubectl set image deploy/raceemu raceemu=192.168.0.203:5000/raceemu:<短縮 SHA> -n raceemu
```

戻すときは `current` に指し直してから `suspend` を外す。
止めたまま忘れると、以後の `main` が出なくなる。

### 4.3 本番の Deployment は `deploy/k8s.yaml` と違う

本番の `raceemu` はリポジトリの `deploy/k8s.yaml` から置かれたものではない。
いまの `deploy/k8s.yaml` をそのまま `apply` すると、イメージが ghcr.io に切り替わる。
Service も `type` と MetalLB の注釈が無いので、LAN の `192.168.0.206` が外れる。

| | `deploy/k8s.yaml` | 本番 |
| --- | --- | --- |
| イメージ | `ghcr.io/promodeler314-a11y/raceemu:main` | `192.168.0.203:5000/raceemu:current` |
| 入れ替えの戦略 | 既定（RollingUpdate） | `Recreate` |
| Service | ClusterIP | `LoadBalancer`（MetalLB、`192.168.0.206`） |
| 注釈 `raceemu.dev/commit` | 無い | 4.2 節が使う |

そのほかの値（PVC `raceemu-data` と `RACEEMU_DATA_DIR=/data`、`fsGroup: 1000`、`RACEEMU_MAX_RUNNING=1`、`RACEEMU_MAX_QUEUED=8`、`RACEEMU_MAX_RACES=2000000`、requests と limits、2 つの probe）は同じである。

**個体の保存は、2026-09-24 まで本番で消えていた。**
本番の Deployment に PVC も `RACEEMU_DATA_DIR` も無く、`apps/api` は個体をメモリの SQLite に持っていた（起動時のログに「再起動で消える」と出る）。
4.2 節の仕組みは `main` に何か入るたびに Pod を作り直すので、保存した個体はそこで無くなっていた。
`deploy/k8s.yaml` と同じ PVC（1 GiB、`local-path`）と `volumeMounts`、`RACEEMU_DATA_DIR` を本番に足して直した。
起動時のログが「個体の保存: /data」になっていれば効いている。

**`local-path` の PVC は最初に置かれたノードに縛られる。**
Pod はそのノードでしか立ち上がらなくなる（いまは `k3s-worker1`）。
ノードを止めるとアプリも止まり、ノードを失うと保存した個体も失う。
`raceemu-gate-data` も同じ扱いである。

`/api/health` が返す `concurrencySource` が `cgroup` であれば、[設計](server-design.md)の 4.1 節の前提どおりに並列数を読めている（本番は `cgroup` で 4 本）。
`availableParallelism` と出ていたらクォータを読めておらず、ノードのコア数で走っている。
`RACEEMU_CONCURRENCY` を置いて明示する。

```
curl -s http://192.168.0.206/api/health          # LAN の中から
```

### 4.4 外に出す口はゲートウェイを通る

外からの経路は `raceemu.promodeler314.win` → Cloudflare のトンネル → `raceemu-gate` → `raceemu` である。
`apps/api` 自身は認証を持っていない。
探索は 1 本で 25 万レース規模になるので、誰でも投げられる状態で外に出すと、そのまま計算資源を配ることになる。
その手前に `raceemu-gate` を置いている。

`raceemu-gate` は依存の無い Node の 1 ファイル（`gate.js`、ConfigMap `raceemu-gate-src`）で、口を 2 つ持つ。

- **`:8080` アプリ。** Discord の Bot が配ったマジックリンクを持っている人だけを通し、上流（`raceemu.raceemu.svc.cluster.local:80`）へ流す。リンクは Bot が `MAGIC_SECRET` で署名したもので、ゲートは署名と期限を確かめるだけである。通したあとは 24 時間のセッションになる。
- **`:8090` 集計画面。** 誰が何をどれだけ使ったかを出す。別のホスト名を割り当て、Cloudflare Access で持ち主だけに絞る。

使用済みのリンクと利用の記録は SQLite（PVC `raceemu-gate-data` の `/data/usage.db`）に持つ。
署名の鍵は Secret `raceemu-gate` にある。
ゲートの中身はこのリポジトリに無く、別の手順（`raceemu-gate-apply.sh`）で ConfigMap に入れている。

**LAN の `192.168.0.206` はゲートを通らない。**
Service `raceemu` が MetalLB で LAN に直に出ているためである。
LAN の外には出ていないが、LAN の中からは誰でも探索を投げられる。

トンネルの宛先の設定はクラスタの中ではなく Cloudflare のダッシュボード（Zero Trust → Networks → Tunnels → 該当のトンネル → Public Hostname）にある。
Service の URL 欄にはスキーム（`http://`）を付けず、ホスト名とポートだけを入れる。
Type を別に選ぶ欄がある。

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

### 6.1 置き場は `apps/web/public/skill-list/<版>/<場>-<コース>.json`

`apps/web/public` は Vite が中身をそのまま `dist` に写す場所である。
**バンドルには入らない。**
`import` していないので依存の木に載らず、`vite.config.ts` の `trimSkillData` も通らない。
`pnpm build` の後、`dist/skill-list/<版>/<場>-<コース>.json` として出る。

**表はコースごとに 1 枚である。** 全 137 コースを 1 枚にすると 25 MB を超え、
画面がコースを選ぶためだけにそれを取ることになる。
1 枚 200 KB 前後に分けてあるので、画面は選ばれたコースだけを取る。

これは 1 節の表に載っている 4 ファイルの外側にあり、`pnpm e2e` のバンドル上限（`assets/index-*` と `assets/browser-worker-*` の大きさ）にも影響しない。
逆に言うと、うっかり `import` に変えるとバンドルが数 MB 太るので、`e2e` のほうで落ちる。

`apps/api` の静的配信（`http.ts` の `serveStatic`）は `RACEEMU_STATIC_ROOT`（イメージでは `/app/apps/web/dist`）の下をそのまま返すので、同じ `/skill-list/<版>/<場>-<コース>.json` で取れる。
`deploy/Dockerfile` は `apps/` を丸ごと写してから `pnpm build` するため、イメージにも一緒に入る。

**版がパスに入っているので、キャッシュは不変にしてよい。**
`serveStatic` は `public, max-age=31536000, immutable` を付ける。
中身が変われば版が変わり、版が変われば名前が変わるので、古いものを掴んだままになることはない。

**ただし入口だけは別である。**
読む側は版もコースのファイル名も当てられない（版はデータと計算式と相手の分布の指紋から決まり、置いてあるコースは回した範囲で決まる）ので、名前を教える 1 枚 `skill-list/index.json` をあいだに置いている（`SkillListIndex`）。
これは**名前が変わらないまま中身が入れ替わる**唯一のファイルで、不変として配ると新しい版を置いても画面が古い名前を取りに行き続ける。
版がパスに入っている効き目が、入口のところで消えてしまう。
`index.html` と同じ扱い（`no-cache`）にしてある。
`serveStatic` は拡張子ではなくファイル名で見分けており、そのための一覧が `REVALIDATE_NAMES` である。

大きさのために 2 つ手当てをしてある。

- **64 kB を超える JSON/JS/CSS/SVG は、その場で gzip に掛けて出す。**
  1 コース 200 KB 前後で、縮めずに出すと他の資産の合計より大きくなる。
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

### 6.4 回す前に版を見る

作り直しは 24 分片で 50 ジョブ時間ほどかかる。
**それを全部回してから「版は変わらなかった」と気付くのでは遅い。**

起動条件の 4 パスのうち `packages/sim/src/field/field.ts` は普通の開発で動く。
一方で版を決めるのは `defaultFieldProfile` の**中身**の指紋なので、
ファイルを触っても版が変わらない回のほうが多い（実際、リポジトリの最初の 12 日で
`field.ts` は 6 回動いている）。

そこで `matrix` の前に `plan` を置く。
`pnpm skill-list-check` がリポジトリの中の材料だけから版を計算し（数秒）、
置いてある `index.json` と突き合わせて `version` / `courses` / `total` / `complete` を出す。
**CLI は事実だけを出し、回すかどうかはワークフローが決める**（`force` の扱いはワークフローの領分である）。

- 版が同じで全 137 コース揃っている → `changed=false`。`measure` も `collect` も走らない。
- **揃っていない → 作り直す。** 前回こけた分片のコースが欠けたままになるからである。
- `force` が指定された → 常に作り直す。

版の計算は生成・取りまとめとまったく同じ関数（`readSkillListDataset`）を使う。
**ここだけ別に計算すると、関所が「変わっていない」と言ったのに実は違う版だった、
という取り違えが起きる。** 表は古いまま、作り直しは二度と走らない（しかも緑）。
`test/workflows.test.ts` が 3 つとも同じ関数を呼んでいることを見ている。

なお `plan` が止めた回と `plan` 自身がこけた回には `collect` も走らない
（`if` が `needs.plan.result == 'success'` を含む）。
分片が何本かこけた回に走るのは `always()` ではなく `!cancelled()` である。

### 6.5 1 ジョブには収まらないので、コースで分けて回す

GitHub Actions の 1 ジョブの上限は 6 時間である。
全 137 コースは手元の 4 コアで 40 時間を超え、`ubuntu-latest` の 4 vCPU はさらに遅い。
**1 本では収まらない。**

そこで `measure` を `matrix` の 24 本に分け、`--shard i/24` でコースを配る。
分片は飛ばし飛ばしに取る（`packages/solver/src/skill-list-run.ts` の `shardCourses`）。
先頭から切り分けると、長距離ばかりを引いた分片だけが極端に遅くなるからである。
意図を残すため `timeout-minutes: 350` で切ってある（既定の 360 分のまま放置すると、暴走したときに上限いっぱいまで回る）。

**24 という数は上限からの逆算である。** 1 分片 6 本前後で、1 本あたり 20〜30 分
（試行 200、4 vCPU）だから 2〜3 時間になる。12 分片だと 4〜5 時間で、長いコースを
多く引いた分片が 6 時間に当たりうる。**そこで落ちるとその分片のコースが丸ごと落ちる**ので、
余裕を持たせるほうを採った。分片を増やしても合計の計算量は変わらない。

**分片の数は `env.SHARDS` と `matrix.shard` の両方に書く。**
GitHub Actions は `matrix` に環境変数を展開できないので、ここだけは二重に書くしかない。
食い違うと、上のほうの分片が 1 本も走らず**そのコースが永久に測られない**（しかも緑で終わる）ので、
`test/workflows.test.ts` が 2 つの数を突き合わせている。

分片はそれぞれ自分が測ったコースしか知らない。
最後の `collect` が成果物を集め、`pnpm skill-list-collect` が**置いてあるものを数え直して** `index.json` を書く。
版の計算は生成と同じ関数（`readSkillListDataset`）を使う。
ここが食い違うと置いてあるコースを 1 本も見つけられず、画面からは「表が無い」と区別が付かないまま緑で終わる。

**1 本こけても他は捨てない**（`fail-fast: false`、`collect` は `if: always()`）。
表はコースごとに 1 枚なので、こけた分片のコースが一覧に載らないだけである。
それを「まだ測っていない」と読めるのがこの形の利点で、何十時間かけた他の分片まで捨てる理由が無い。
こけたことは PR 本文に警告として出す（黙って少ないコースを配ってはならない）。

**1 本も成果が無ければ `collect` が赤で落ちる。** 表が無いまま PR を出すことはしない。

### 6.6 リポジトリには 2 世代だけ残す

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

- **版はディレクトリである。** 1 コース 1 枚を並べたものが 1 つの版なので、掃除の単位もディレクトリである。`index.json` は版ではないから、掃除の対象から外す。並べて数えると、版として落ちるか、いちばん古いものとして最初に消える。
- **`version` が指す版は、残す世代数によらず必ず残す。** 並びの先頭に固定してから数える。版が変わらなかった回に `force` で作り直すと、`version` の commit の時刻がいちばん古い側に来ることがありうる。
- **`version` が指す版が無ければ赤で落とす。** そのまま配ると画面が 404 を引く。掃除で消えた場合も、CLI が食い違ったものを書いた場合も、同じところで止まる。
- **コースが 1 本も載っていない一覧も赤で落とす。** 画面から見れば「表が無い」のと同じである。

並びは `git log -1 --format=%ct` で測った commit の時刻で決める。
checkout した直後はファイルの更新時刻が全部同じになるので、ファイルシステムからは決まらない。
今回作ったものはまだ commit されていないため行が出ず、いちばん新しいものとして扱われる。

**消しても軽くならないことは承知の上である。**
git は消しても履歴に残るので、作り直した回数ぶんの 25 MB は clone に永久に載る。
本家の版が 2〜4 週ごとであることを考えると、年に 10〜25 回、**300 MB から 600 MB** 積む。
**コース単位にしたぶん、1 回あたりが重くなった。** ここは先に限界が来る側である。

**それでも当面はリポジトリに置く。** 静的配信のホストを何も足さずに済み、
`deploy/Dockerfile` が `apps/` を写すだけで配れるからである（6.1 節）。
桁を詰めて減らす案は測ったうえで捨てた。`mean` と `stdError` を 4 桁、
`triggerRate` を 2 桁に落としても**全体で 6.6 %（1.7 MB）しか減らない**。
配信では gzip が効いていて 1 枚 189 KB → 42 KB になっており、縮める仕事はそちらが済ませている。

効くのは桁ではなく**回数**なので、先に 6.4 節の関所を入れた。

**考え直す目安を決めておく。`.git` が 500 MB を超えたら、配布方法のほうを変える。**
（いまは 52 MB。）そのときの候補は、データだけを別のブランチや Releases に出して
配信時に取りに行く形だが、どれも 6.1 節の「何も足さずに配れる」を失う。
目安を決めずに先送りすると、気付いたときには clone が重くなっている。
それでも当面はリポジトリに置く。
静的配信のホストを何も足さずに済み、`deploy/Dockerfile` が `apps/` を写すだけで配れるからである（6.1 節）。

**重くなってきたら、配り方のほうを変える。**
表をリポジトリから外して GitHub Release の添付か `ghcr.io` の別レイヤに置き、画面はそちらを取りに行く形になる。
そのときは同一オリジンでなくなるので CORS が要る（[サーバ側の設計](server-design.md)の 5 節）。
先にやらないのは、**まだ何 MB になるか実測していない**からである。
代表コースで一度作って、`git count-objects -vH` の伸びを見てから決める。
