# raceemu

ウマ娘レースエミュレータ（https://mee1080.github.io/umasim/race/）の調査と、それをもとにした改良版 Web アプリの設計。

- [ウマ娘レースエミュレータ（mee1080/umasim）の解析](docs/race-emulator-analysis.md)
- [レースエミュレータ改良版の設計](docs/webapp-design.md)
- [逆算と組み合わせ探索の設計](docs/solver-design.md)
- [順位条件の扱い](docs/order-condition.md)
- [M1 の結果](docs/m1-report.md)
- [M2 の結果](docs/m2-report.md)
- [M3 の結果](docs/m3-report.md)
- [M4 の結果](docs/m4-report.md)
- [M5 の結果](docs/m5-report.md)

## 開発

```
pnpm install
pnpm test        # 本家との突き合わせとスキル条件の網羅
pnpm typecheck
pnpm sim --count 1000 --location 10006 --course 10606
pnpm bench --count 10000       # 並列実行の実測
pnpm dev                       # UI の開発サーバ
pnpm build                     # UI のビルド
pnpm e2e                       # ビルドした UI を実際のブラウザで確認
pnpm monotonicity --trials 60  # 逆算の前提（単調性）の検査
```

`packages/sim` が計算モデル、`packages/data` がコースデータとスキルデータ、`packages/solver` が逆算と探索、`apps/web` が UI である。
計算モデルは [mee1080/umasim](https://github.com/mee1080/umasim) からの移植であり、本リポジトリも AGPL v3 とする。
