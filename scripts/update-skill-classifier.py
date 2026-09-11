"""
スキル分類モデルを umacapture の配布物から取り直す。

  python3 scripts/update-skill-classifier.py [modules.zip]

引数を渡せばその zip を読む。省略すると配布元から取ってくる。

## なぜ要るか

`apps/api/assets/skill-classifier/model.onnx` は umacapture が配る学習済み
モデルで、分類できるのは学習した時点のスキルだけである。ゲームに新しい
スキルが増えても、モデルが古いままでは**そのスキルを選べない**。選べない
だけなら気付けるが、実際には見た目のいちばん近い既知のスキルを、高い確信度
で返す。読み取りが静かに間違う。

データのほうは週次で追随している（`.github/workflows/sync-game-data.yml`）
ので、放っておくとモデルだけが取り残される。

## 何をするか

1. `modules.zip` から `skill/prediction.onnx` と `labels.json` を取り出す。
2. onnx を `apps/api/assets/skill-classifier/model.onnx` に置く。
3. `labels.json` を材料に `scripts/build-skill-classifier-labels.ts` を回して
   `label-map.json`（分類番号 → うちのスキル ID）を作り直す。

**`labels.json` はリポジトリに残さない。** Cygames の著作物であるスキル名が
そのまま入っている。対応表のほうはこちらが作った事実の並びなので置いてよい。
`model.onnx` は `license.md` によりパブリックドメインである（同梱の
`NOTICE.md` に引用してある）。

モデルと対応表は必ず一緒に入れ替える。分類番号の並びはモデルごとに違うので、
片方だけ新しいと**全部のスキルが 1 つずれた答えになる**。
"""
import io
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

MODULES_URL = 'https://data.umacapture.com/umacapture/modules.zip'
ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'apps' / 'api' / 'assets' / 'skill-classifier'


def load_zip(source):
    if source is not None:
        return zipfile.ZipFile(source)
    print(f'{MODULES_URL} から取ってくる')
    with urllib.request.urlopen(MODULES_URL, timeout=120) as res:
        body = res.read()
    # 配布元がエラーページを返したときに、それを zip として開こうとして
    # 分かりにくい失敗にならないよう、先に見ておく。
    if len(body) < 100_000:
        raise SystemExit(f'取れた中身が小さすぎる: {len(body)} バイト')
    return zipfile.ZipFile(io.BytesIO(body))


def find_model(zf):
    """スキルの分類モデル。`skill/prediction.onnx` で終わる項目を探す。"""
    names = [n for n in zf.namelist() if re.search(r'(^|/)skill/prediction\.onnx$', n)]
    if len(names) != 1:
        raise SystemExit(f'skill/prediction.onnx が 1 つに定まらない: {names}')
    return names[0]


def find_labels(zf):
    """
    分類番号の順に並んだスキル名。

    置き場所は版によって変わりうるので、名前ではなく中身で探す。
    `skill.name` を持つ JSON がそれである。
    """
    for name in zf.namelist():
        if not name.endswith('.json'):
            continue
        try:
            body = json.loads(zf.read(name))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if isinstance(body, dict) and isinstance(body.get('skill.name'), list):
            return name
    raise SystemExit('skill.name を持つ labels.json が見つからない')


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else None
    zf = load_zip(source)

    model_name = find_model(zf)
    labels_name = find_labels(zf)
    labels = json.loads(zf.read(labels_name))
    print(f'モデル: {model_name} / 名前の表: {labels_name}（{len(labels["skill.name"])} 件）')

    model = zf.read(model_name)
    target = ASSETS / 'model.onnx'
    before = target.read_bytes() if target.exists() else b''
    if model == before:
        print('モデルは変わっていない')
    else:
        target.write_bytes(model)
        print(f'{target} を更新した（{len(before):,} → {len(model):,} バイト）')

    # 対応表は既にある TypeScript の側で作る。名前の正規化（`normalizeSkillName`）を
    # こちらで書き直すと、突き合わせの仕方が二重になって食い違う。
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 'labels.json'
        path.write_text(json.dumps(labels, ensure_ascii=False), encoding='utf-8')
        subprocess.run(
            ['pnpm', 'exec', 'tsx', 'scripts/build-skill-classifier-labels.ts', str(path)],
            cwd=ROOT,
            check=True,
        )


if __name__ == '__main__':
    main()
