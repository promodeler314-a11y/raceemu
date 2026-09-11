"""
本家（mee1080/umasim）のスキル・コースデータを取り直す。

packages/data/assets/{skills,courses}.json は本家の値をそのまま持っている
（docs/m1-report.md 1 節）。新しいウマ娘やスキルは本家のデータが更新され
次第そちらに載るので、ここで定期的に取り直せば追随できる。
週次の .github/workflows/sync-game-data.yml がこれを呼び、差分があれば
PR を出す。

データの出どころは docs/race-emulator-analysis.md 2 節のとおり。
スキルは起動時に取ってくる生の JSON、コースは Kotlin のソースに埋め込まれた
JSON 文字列である。

条件や効果の種類（`type` 文字列）が新規のときはコード側の対応が要る
（同じ節）。`pnpm test` の「スキル条件の網羅」がその漏れを検出する。

  python3 packages/data/scripts/sync-game-data.py
"""
import json
import re
import urllib.request
from pathlib import Path

SKILL_URL = 'https://raw.githubusercontent.com/mee1080/umasim/refs/heads/main/data/skill_data.txt'
COURSE_URL = (
    'https://raw.githubusercontent.com/mee1080/umasim/refs/heads/main/'
    'race/src/commonMain/kotlin/io/github/mee1080/umasim/race/data/rawData.kt'
)
ASSETS = Path(__file__).resolve().parent.parent / 'assets'


def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as res:
        return res.read().decode('utf-8')


def fetch_skills():
    skills = json.loads(fetch(SKILL_URL))
    # 取得先が壊れた・エラーページを返したなどで空に近い結果が来たら、
    # 気付かずに上書きしないよう先に止める。
    if not isinstance(skills, list) or len(skills) < 1000:
        n = len(skills) if isinstance(skills, list) else type(skills).__name__
        raise SystemExit(f'取れたスキル数が少なすぎる: {n}')
    return skills


def fetch_courses():
    text = fetch(COURSE_URL)
    m = re.search(r'internal val rawCourseData = """(.*?)"""', text, re.S)
    if m is None:
        raise SystemExit('rawData.kt から rawCourseData を取り出せなかった（本家が形式を変えた？）')
    courses = json.loads(m.group(1))
    if not isinstance(courses, dict) or len(courses) < 10:
        n = len(courses) if isinstance(courses, dict) else type(courses).__name__
        raise SystemExit(f'取れた競馬場数が少なすぎる: {n}')
    return courses


def describe(items, limit=20):
    shown = '、'.join(items[:limit])
    more = f' ほか {len(items) - limit} 件' if len(items) > limit else ''
    return shown + more


def diff_lines(label, old_by_id, new_by_id, display):
    """
    ID をキーにした辞書どうしを比べる。追加・削除・変更の判定は値そのもの
    （old_by_id/new_by_id の中身）で行い、表示だけ `display` を通す。
    """
    lines = []
    added = [k for k in new_by_id if k not in old_by_id]
    removed = [k for k in old_by_id if k not in new_by_id]
    changed = [k for k in new_by_id if k in old_by_id and new_by_id[k] != old_by_id[k]]
    if added:
        lines.append(f'{label}追加 {len(added)} 件: ' + describe([display(new_by_id[k]) for k in added]))
    if removed:
        lines.append(f'{label}削除 {len(removed)} 件: ' + describe([display(old_by_id[k]) for k in removed]))
    if changed:
        lines.append(f'{label}変更 {len(changed)} 件: ' + describe([display(new_by_id[k]) for k in changed]))
    return lines


def skill_label(skill):
    return f"{skill['name']}（{skill['id']}）"


def skill_bodies(skills):
    return {s['id']: s for s in skills}


def flatten_courses(courses):
    """競馬場ごとの入れ子を、コース ID → (競馬場名, コース本体) の平らな辞書にする。"""
    out = {}
    for loc in courses.values():
        for course_id, course in (loc.get('courses') or {}).items():
            out[course_id] = (loc.get('name'), course)
    return out


def course_label(entry):
    loc_name, course = entry
    return f"{loc_name} {course.get('name')}"


def main():
    skills_path = ASSETS / 'skills.json'
    courses_path = ASSETS / 'courses.json'
    old_skills = json.loads(skills_path.read_text(encoding='utf-8'))
    old_courses = json.loads(courses_path.read_text(encoding='utf-8'))

    new_skills = fetch_skills()
    new_courses = fetch_courses()

    lines = diff_lines('スキル', skill_bodies(old_skills), skill_bodies(new_skills), skill_label)
    lines += diff_lines('コース', flatten_courses(old_courses), flatten_courses(new_courses), course_label)

    added_locations = [v['name'] for k, v in new_courses.items() if k not in old_courses]
    removed_locations = [v['name'] for k, v in old_courses.items() if k not in new_courses]
    if added_locations:
        lines.append('競馬場追加: ' + describe(added_locations))
    if removed_locations:
        lines.append('競馬場削除: ' + describe(removed_locations))

    def dump(obj, path):
        path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    dump(new_skills, skills_path)
    dump(new_courses, courses_path)

    print('\n'.join(lines) if lines else '変わっていない')


if __name__ == '__main__':
    main()
