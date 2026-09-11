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
