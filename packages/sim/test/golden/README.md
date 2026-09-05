# 参照値の作り方

`umasim-reference.json` は、本家 [mee1080/umasim](https://github.com/mee1080/umasim) を JVM で実行して得た値である。
移植版が本家と一致していることを確かめるために使う。

再生成の手順は次のとおりである。

1. 本家をクローンする。

   ```
   git clone --depth 1 https://github.com/mee1080/umasim
   ```

2. Gradle のツールチェーン指定を、手元の JDK に合わせる。
   本家は JDK 17 を要求するが、手元に 21 しか無い場合は `gradle/libs.versions.toml` の `jvmTarget` を書き換える。

3. `race/src/commonTest/kotlin/io/github/mee1080/umasim/race/calc2/` に、参照値を標準出力へ書き出すテストを置く。
   出力する内容は次の三つである。

   - `=== DERIVED <ラベル>` に続けて `RaceSettingWithPassive` の導出値を `キー=値` の形で並べる。
   - `=== TIMES <ラベル>` に続けて、2万回シミュレートしたタイムの平均、標準偏差、標準誤差、分位点、最大スパート率、完走率を並べる。
   - スキルを持つケースでは `=== SKILLIDS <ラベル>` に続けてスキル名と ID を並べる。

4. テストを走らせる。

   ```
   ./gradlew :race:jvmTest --tests '*RefDumpTest*' --rerun-tasks
   ```

5. `race/build/test-results/jvmTest/TEST-*.xml` の `system-out` から値を取り出し、
   `{ ラベル: { derived: {...}, times: {...} } }` の形の JSON にして本ファイルの隣に置く。

## 比較の方針

本家と移植版では乱数の実装が違うため、1 レースの厳密一致は取れない。
そこで二段構えにしている。

- **導出値**：レース前に確定する値なので、小数第 9 位まで一致するはずである。ここが合わないのは移植の誤りである。
- **タイムの分布**：平均の差が標準誤差の 4 倍に収まること、最大スパート率と完走率の差が 2 ポイント以内であることを確かめる。

既定の試行回数は 5000 である。
`REFERENCE_TRIALS=20000 pnpm test` のように環境変数で増やせる。

## 現在の参照ケース

| ラベル | コース | 脚質 | スキル |
| --- | --- | --- | --- |
| `A_tokyo2400_sen` | 東京 芝2400m | 先行 | なし |
| `B_sapporo1200_nige` | 札幌 芝1200m | 逃げ | なし |
| `C_tokyo2400_sen_skills` | 東京 芝2400m | 先行 | 6 種類 |

C のスキルは、パッシブ、回復、目標速度上昇、ランダム発動区間、近似条件を一通り含むように選んである。
