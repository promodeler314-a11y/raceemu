# model.onnx の出どころ

[umasagashi/umacapture](https://github.com/umasagashi/umacapture)（MIT）が
`https://data.umacapture.com/umacapture/modules.zip` で配布している
`skill/prediction.onnx` をそのまま置いている。

同梱の `license.md` に次のとおりある（要約ではなく該当部分の引用）。

> ### License for `prediction.onnx` files
>
> These files are public domain.
> You do not need to include this license notice or credit, and you do not
> need to ask permission or report to me.
> However, the content is provided without any warranties or liabilities.
> Use at your own risk.

`label-map.json`（分類番号→うちのスキル ID の対応表）はこちらで生成した別物で、
umacapture 側の `labels.json`（Cygames の著作物を含む）はコピーしていない。
作り方は `scripts/build-skill-classifier-labels.ts` を参照。

読み取り方の設計は `docs/ocr-design.md` の 6 節を参照。
