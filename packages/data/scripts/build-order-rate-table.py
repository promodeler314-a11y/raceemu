"""
順位率の条件から該当順位への対応表を、スキルデータの注記から組み立てる。

本家の注記には条件ごとに 9 頭立てと 12 頭立ての該当順位が書かれている。
単一の境界を示す注記と範囲を示す注記の両方から境界を取り出す。
docs/order-condition.md 2 節を参照。

  python3 packages/data/scripts/build-order-rate-table.py <skills.json> <出力先.ts>
"""
import json
import re
import sys
from collections import defaultdict

HEAD_COUNTS = {'チャンミ': 9, 'LoH': 12}
SINGLE = re.compile(r'順位率(\d+)(以下|以上|より大|未満|以降維持|以前維持)（チャンミ([～\d]+)/LoH([～\d]+)）')
RANGE = re.compile(r'順位率(\d+)[～~](\d+)(?:維持)?（チャンミ([～\d]+)/LoH([～\d]+)）')


def bounds(spec, n):
    if spec.startswith('～'):
        return 1, int(spec[1:])
    if spec.endswith('～'):
        return int(spec[:-1]), n
    if '～' in spec:
        a, b = spec.split('～')
        return int(a), int(b)
    return int(spec), int(spec)


def main(skills_path, out_path):
    skills = json.load(open(skills_path))
    tables = {op: defaultdict(dict) for op in ('>=', '<=', '>', '<')}
    conflicts = []

    def put(op, value, n, rank, source):
        table = tables[op]
        if n in table[value] and table[value][n] != rank:
            conflicts.append((op, value, n, table[value][n], rank, source))
        else:
            table[value][n] = rank

    for skill in skills:
        for text in skill.get('info', []):
            for m in SINGLE.finditer(text):
                value, op, cm, loh = m.groups()
                value = int(value)
                for label, spec in (('チャンミ', cm), ('LoH', loh)):
                    n = HEAD_COUNTS[label]
                    lo, hi = bounds(spec, n)
                    if op in ('以上', '以降維持'):
                        put('>=', value, n, lo, m.group(0))
                    elif op in ('以下', '以前維持'):
                        put('<=', value, n, hi, m.group(0))
                    elif op == 'より大':
                        put('>', value, n, lo, m.group(0))
                    elif op == '未満':
                        put('<', value, n, hi, m.group(0))
            for m in RANGE.finditer(text):
                a, b, cm, loh = m.groups()
                a, b = int(a), int(b)
                for label, spec in (('チャンミ', cm), ('LoH', loh)):
                    n = HEAD_COUNTS[label]
                    lo, hi = bounds(spec, n)
                    put('>=', a, n, lo, m.group(0))
                    put('<=', b, n, hi, m.group(0))

    if conflicts:
        print('注記どうしが矛盾している:', conflicts, file=sys.stderr)
        return 1

    used = defaultdict(int)
    for skill in skills:
        for invoke in skill.get('invokes', []):
            for group in invoke.get('conditions', []) + invoke.get('preConditions', []):
                for cond in group:
                    if cond['type'] == 'order_rate':
                        used[(cond['operator'], cond['value'])] += 1

    missing = [(op, v, n) for (op, v) in used for n in (9, 12) if n not in tables[op][v]]
    if missing:
        print('注記から埋まらない条件がある:', missing, file=sys.stderr)
        return 1

    lines = [
        '// このファイルは packages/data/scripts/build-order-rate-table.py が生成する。手で編集しない。',
        '',
        '/**',
        ' * 順位率の条件から、その条件を満たす順位の境界への対応表。',
        ' *',
        ' * 順位率の定義そのものは確定していないが、対応する頭数を 9 と 12 に限れば',
        ' * 表で足りる。表は本家のスキルデータの注記から組み立てており、',
        ' * 実際に使われている条件はすべて埋まっている。',
        ' * docs/order-condition.md 2 節を参照。',
        ' */',
        'export interface OrderRateBoundary {',
        '  /** この順位以降が条件を満たす（>= と > の場合） */',
        '  readonly atLeast?: number;',
        '  /** この順位以内が条件を満たす（<= と < の場合） */',
        '  readonly atMost?: number;',
        '}',
        '',
        '/** キーは `${operator}:${value}:${頭数}` */',
        'export const orderRateBoundaries: Readonly<Record<string, OrderRateBoundary>> = {',
    ]
    for op in ('>=', '>', '<=', '<'):
        for value in sorted(tables[op]):
            for n in sorted(tables[op][value]):
                rank = tables[op][value][n]
                field = 'atLeast' if op in ('>=', '>') else 'atMost'
                lines.append(f"  '{op}:{value}:{n}': {{ {field}: {rank} }},")
    lines += ['};', '']
    open(out_path, 'w').write('\n'.join(lines))
    covered = sum(used.values())
    print(f'対応表を書き出した: 条件 {len(used)} 通り、出現 {covered} 回、矛盾なし')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
