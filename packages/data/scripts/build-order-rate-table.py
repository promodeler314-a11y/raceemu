"""
順位率の条件から該当順位への対応表を、スキルデータの注記から組み立てる。

本家の注記には条件ごとに 9 頭立てと 12 頭立ての該当順位が書かれている。
単一の境界を示す注記と範囲を示す注記の両方から境界を取り出す。
docs/order-condition.md 2.1 節を参照。

9 頭と 12 頭以外の頭数は、表の全項目を再現する式 H で延ばす（2.2 節、
packages/sim/src/data/orderRateResolve.ts）。延ばし方の前提が崩れていないかを
ここで確かめる。表のどれか 1 項目でも H と食い違えば、書き出さずに止まる。

  python3 packages/data/scripts/build-order-rate-table.py <skills.json> <出力先.ts>
"""
import json
import re
import sys
from collections import defaultdict

HEAD_COUNTS = {'チャンミ': 9, 'LoH': 12}
SINGLE = re.compile(r'順位率(\d+)(以下|以上|より大|未満|以降維持|以前維持)（チャンミ([～\d]+)/LoH([～\d]+)）')
RANGE = re.compile(r'順位率(\d+)[～~](\d+)(?:維持)?（チャンミ([～\d]+)/LoH([～\d]+)）')


def formula_h(op, value, n):
    """式 H。T = floor(X(n-1)/100) + 1 を整数のまま計算する。orderRateResolve.ts と同じもの。"""
    t = value * (n - 1) // 100 + 1
    return t + 1 if op in ('>', '<') else t


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
    skills = json.load(open(skills_path, encoding='utf-8'))
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

    # 9 頭と 12 頭以外へ延ばす式 H が、注記から組んだ表の全項目と一致すること。
    # 食い違えば延ばした境界の根拠が崩れるので、表を書き出さずに止まる。
    mismatched = [
        (op, value, n, rank, formula_h(op, value, n))
        for op, table in tables.items()
        for value, by_n in table.items()
        for n, rank in by_n.items()
        if formula_h(op, value, n) != rank
    ]
    if mismatched:
        print('式 H が注記と食い違う（演算子, 値, 頭数, 注記, 式）:', mismatched, file=sys.stderr)
        return 1
    entries = sum(len(by_n) for table in tables.values() for by_n in table.values())

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
    lines += CONTINUE_SECTION
    with open(out_path, 'w', encoding='utf-8', newline='\n') as out:
        out.write('\n'.join(lines))
    covered = sum(used.values())
    print(f'対応表を書き出した: 条件 {len(used)} 通り、出現 {covered} 回、矛盾なし、'
          f'表の {entries} 項目すべてが式 H と一致')
    return 0


# 帯を維持する条件の一覧と、表だけを引く古い口。表のあとにそのまま書き出す。
# 境界の解決（式 H で延ばすことを含む）は orderRateResolve.ts が持つ。
# ここの resolveOrderRateContinue は 9 頭と 12 頭の表しか引かないが、
# 生成物の中身を変えないため、以前の形のまま残してある。
CONTINUE_SECTION = [
    '/**',
    ' * 順位率の帯を「ずっと維持しているか」で見る条件。',
    ' *',
    ' * `order_rate_in20_continue` は順位率 20 以前を、`order_rate_out40_continue` は',
    ' * 順位率 40 以降を、レースの開始からその時点まで一度も外れていないことを指す。',
    ' * 値は常に 1 で、真偽として使われる。',
    ' *',
    ' * 実際にスキルデータに現れるのは次の 8 種類である。',
    ' */',
    'export const ORDER_RATE_CONTINUE_TYPES: readonly string[] = [',
    "  'order_rate_in20_continue',",
    "  'order_rate_in40_continue',",
    "  'order_rate_in50_continue',",
    "  'order_rate_in80_continue',",
    "  'order_rate_out20_continue',",
    "  'order_rate_out40_continue',",
    "  'order_rate_out50_continue',",
    "  'order_rate_out70_continue',",
    '];',
    '',
    '/**',
    ' * 帯の条件から順位の境界を引く。',
    ' * `in` は順位率がその値以前、`out` は以降。対応表は 9 頭立てと 12 頭立てだけを埋めてある。',
    ' */',
    'export function resolveOrderRateContinue(',
    '  type: string,',
    '  gateCount: number,',
    '): OrderRateBoundary | undefined {',
    r"  const matched = /^order_rate_(in|out)(\d+)_continue$/.exec(type);",
    '  if (matched === null) return undefined;',
    "  const operator = matched[1] === 'in' ? '<=' : '>=';",
    '  return orderRateBoundaries[`${operator}:${matched[2]}:${gateCount}`];',
    '}',
    '',
]


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
