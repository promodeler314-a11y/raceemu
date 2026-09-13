"""
本家（mee1080/umasim）の race モジュールが動いたかを見る。

  python3 scripts/check-race-model.py [本家のクローン]

引数を渡せばそのディレクトリを読む。省略すると GitHub の API から取ってくる。
週次の .github/workflows/check-race-model.yml がこれを呼び、差分があれば PR を出す。

## なぜ要るか

週次で追いかけているのはデータだけである（sync-game-data.yml）。
本家は 2 週から 4 週ごとに版を出し、そのうち**計算側の変更はデータの取り直しでは
拾えない**。全開スパート、クールダウン 2 秒、超常体験はどれもコードの変更で入った
（docs/race-emulator-analysis.md 9 節）。

こちらの移植は手で追いかけるしかないが、**動いたことにすら気付けない**のが問題である。
参照値（packages/sim/test/golden/umasim-reference.json）は本家を JVM で回して作った
固定値なので、本家が変わってもこちらのテストは緑のままになる。**古い本家と一致している
ことを確かめ続ける**状態になる。

そこで race モジュールのファイルの指紋をリポジトリに置き、週次で取り直して突き合わせる。

## 何をするか

1. 本家の `race/` 以下のファイルを列挙し、1 つずつ指紋を取る。
2. packages/sim/upstream/race-manifest.json と突き合わせる。
3. マニフェストを書き直し、何が動いたかを標準出力に出す。

判断は人がやる。指紋は「読みに行け」と言うだけで、計算式が実際に変わったかは言えない
（空白の修正でも指紋は動く）。出力には本家の履歴への URL と、こちらの移植先を添える。

## 指紋に何を使うか

git の blob SHA-1、つまり `sha1("blob <長さ>\\0" + 中身)` である。
GitHub の tree API が返す値そのものなので、**API から取っても手元のクローンから取っても
同じ値になる**。人手でも `git ls-tree -r HEAD -- race` で確かめられる。

## マニフェストが時刻も HEAD の SHA も持たない理由

持たせると、race が動いていない週にもマニフェストが変わって毎週 PR が出る。
本家は core や compose のほうがずっと頻繁に動くので、HEAD の SHA を持つとほぼ毎週である。
オオカミ少年になれば誰も読まなくなり、検知そのものが死ぬ。
マニフェストは追跡対象の中身だけを持ち、**中身が変わったときだけ変わる**。
"""
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = 'mee1080/umasim'
REF = 'main'
TREE_URL = f'https://api.github.com/repos/{REPO}/git/trees/{REF}?recursive=1'
HISTORY_URL = f'https://github.com/{REPO}/commits/{REF}/'

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / 'packages' / 'sim' / 'upstream' / 'race-manifest.json'

# 追跡するのは race モジュールだけである。計算モデルの移植元はここに閉じている
# （docs/race-emulator-analysis.md 冒頭）。core や compose は育成と UI で、
# こちらは移植していない。
TRACKED = 'race/'

KOTLIN = 'race/src/commonMain/kotlin/io/github/mee1080/umasim/race/'

# 本家のファイルと、こちらで追随する場所の対応。
# 前方一致で引くので、長いものから順に並べる。
PORT = [
    (KOTLIN + 'calc2/RaceCalculator.kt', 'packages/sim/src/calculator.ts'),
    (KOTLIN + 'calc2/RaceState.kt', 'packages/sim/src/state.ts'),
    (KOTLIN + 'calc2/SkillChecker.kt', 'packages/sim/src/skill/condition.ts と skill/approximate.ts'),
    (KOTLIN + 'data/constants.kt', 'packages/sim/src/data/constants.ts'),
    (KOTLIN + 'data/trackData.kt', 'packages/sim/src/data/track.ts'),
    (KOTLIN + 'data2/SkillData.kt', 'packages/sim/src/skill/types.ts'),
    (KOTLIN + 'data/rawData.kt', 'packages/data/assets/courses.json'),
]

# 中身がデータであって計算式ではないもの。ここだけが動いたのなら、
# sync-game-data.yml が出す PR のほうで拾える。
DATA_ONLY = {KOTLIN + 'data/rawData.kt'}

# 計算にもデータにも関わらないもの。依存の版上げなどで動く。
BUILD_ONLY = {'race/build.gradle.kts'}

# 取れた数がこれを下回ったら、取得が壊れたと見なして止める。
# 2026 年 9 月時点で 13 ファイルある。
MIN_FILES = 8


def blob_sha(body):
    """git の blob オブジェクト ID。`git hash-object` と同じ値になる。"""
    header = f'blob {len(body)}\0'.encode('utf-8')
    return hashlib.sha1(header + body).hexdigest()


def fetch_tree():
    """GitHub の tree API から、race/ 以下のパスと blob SHA を取る。"""
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'raceemu-race-model-check (+https://github.com/promodeler314-a11y/raceemu)',
    }
    # 認証なしだと 60 回/時で、Actions のランナーは出口 IP を共有するので詰まりうる。
    # ワークフローは GITHUB_TOKEN を渡してくる。
    token = os.environ.get('GITHUB_TOKEN')
    if token:
        headers['Authorization'] = f'Bearer {token}'
    request = urllib.request.Request(TREE_URL, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as res:
            body = json.loads(res.read())
    except urllib.error.HTTPError as error:
        # 403 は大抵このレート制限である。黙って「差分なし」で終わらせない。
        raise SystemExit(
            f'本家の tree を取れない: {error.code} {error.reason}。'
            f'手元のクローンを渡せば API を使わずに済む: '
            f'python3 scripts/check-race-model.py ~/umasim'
        )
    except urllib.error.URLError as error:
        raise SystemExit(f'GitHub に届かない: {error.reason}')

    # 木が大きいと API が途中で打ち切る。打ち切られたものを全体として扱うと、
    # 消えていないファイルを「削除された」と読んでしまう。
    if body.get('truncated'):
        raise SystemExit('tree API の応答が打ち切られた。手元のクローンを渡して確かめること')

    return {
        item['path']: item['sha']
        for item in body.get('tree', [])
        if item.get('type') == 'blob' and item['path'].startswith(TRACKED)
    }


def read_clone(root):
    """
    手元のクローン（または展開した書庫）から、同じ形の対応表を作る。

    API から取ったときは本家が git に入れたものしか見えないが、こちらは
    ディレクトリを歩くので、**Gradle の出力まで拾ってしまう**。
    参照値を作り直した直後のクローンには `race/build/` が数百ファイル入っている。
    それを指紋に混ぜると、以後は毎週「差分あり」になって使いものにならない。

    なお、改行を変換する設定（Windows の core.autocrlf）で取ったクローンからは
    別の指紋が出る。本家に .gitattributes が無いためである。そのときは引数を
    渡さず API から取ること。
    """
    base = Path(root).expanduser().resolve()
    target = base / TRACKED.rstrip('/')
    if not target.is_dir():
        raise SystemExit(f'{target} が無い。本家のクローンを指しているか確かめること')
    files = {}
    for path in sorted(p for p in target.rglob('*') if p.is_file()):
        relative = path.relative_to(base)
        if any(part == 'build' or part.startswith('.') for part in relative.parts):
            continue
        files[relative.as_posix()] = blob_sha(path.read_bytes())
    return files


def load_manifest():
    if not MANIFEST.exists():
        return {}
    return json.loads(MANIFEST.read_text(encoding='utf-8')).get('files', {})


def save_manifest(files):
    body = {
        'repository': REPO,
        'ref': REF,
        # 手で書き換えるものではないので、出どころをファイル自身に持たせる。
        'generatedBy': 'scripts/check-race-model.py',
        # 指紋は git の blob SHA-1 である。`git ls-tree -r main -- race` と突き合わせられる。
        'fingerprint': 'git-blob-sha1',
        'files': dict(sorted(files.items())),
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(body, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def port_of(path):
    for prefix, target in PORT:
        if path == prefix or path.startswith(prefix):
            return target
    return None


def group_of(path):
    if path in DATA_ONLY:
        return 'data'
    if path in BUILD_ONLY:
        return 'build'
    return 'calc'


def describe(kind, path):
    port = port_of(path)
    note = f' → {port}' if port else ''
    return f'- {kind} `{path}`{note}\n  {HISTORY_URL}{path}'


def compare(old, new):
    """
    グループごとの (種別, パス) の一覧を返す。

    追加と削除も見る。本家がファイルを分割・改名したときは中身の追跡が切れるので、
    変更以上に気付く必要がある。
    """
    changes = {'calc': [], 'data': [], 'build': []}
    for path in sorted(set(old) | set(new)):
        if path not in old:
            kind = '追加'
        elif path not in new:
            kind = '削除'
        elif old[path] != new[path]:
            kind = '変更'
        else:
            continue
        changes[group_of(path)].append((kind, path))
    return changes


def summarize(changes):
    lines = []
    calc = changes['calc']
    if calc:
        lines.append('**計算側が動いた。** 移植の追随と参照値の作り直しが要る。')
        lines.append('')
        lines.append(f'計算側 {len(calc)} 件:')
        lines += [describe(kind, path) for kind, path in calc]
    else:
        lines.append('計算側は動いていない。')
    for key, label in (('data', 'データ側（sync-game-data.yml が拾う範囲）'), ('build', 'ビルド設定')):
        rows = changes[key]
        if rows:
            lines.append('')
            lines.append(f'{label} {len(rows)} 件:')
            lines += [describe(kind, path) for kind, path in rows]
    return '\n'.join(lines)


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else None
    new = read_clone(source) if source else fetch_tree()

    # 取得先が壊れた・空を返したときに、それを「本家が消した」と読んで
    # マニフェストを空で上書きしないよう先に止める。
    if len(new) < MIN_FILES:
        raise SystemExit(f'取れた race のファイルが少なすぎる: {len(new)} 件')

    old = load_manifest()
    changes = compare(old, new)
    save_manifest(new)

    if not any(changes.values()):
        print(f'変わっていない（{len(new)} ファイル）')
        return
    print(summarize(changes))


if __name__ == '__main__':
    main()
