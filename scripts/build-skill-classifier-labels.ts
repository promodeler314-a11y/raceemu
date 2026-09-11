/**
 * umacapture（MIT/公開ドメイン、https://github.com/umasagashi/umacapture）が配る
 * スキル分類モデル（apps/api/assets/skill-classifier/model.onnx）の出力番号と、
 * うちのスキル ID の対応表を作る。
 *   tsx scripts/build-skill-classifier-labels.ts <labels.json>
 *
 * <labels.json> は umacapture の modules.zip に入っている labels.json そのもの
 * （Cygames の著作物が入っているのでリポジトリには置かない。要るときだけ手元で
 * 使う）。この JSON の "skill.name" が、モデルの出力番号の順に並んだスキル名。
 *
 * 出力（apps/api/assets/skill-classifier/label-map.json）は「番号→うちのスキル
 * ID」の配列で、こちらの著作物（対応表という事実）だけを持ち、相手の JSON の
 * 中身はコピーしない。
 *
 * 名前が一致しない分は、うちの packages/data に無いスキル（対戦相手にしか
 * 掛からない debuff など）である。数が増えたら見ておく。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadGameData } from '../packages/data/src/node.ts';
import { normalizeSkillName } from '../packages/data/src/skill-match.ts';

const input = process.argv[2];
if (input === undefined) {
  console.error('使い方: tsx scripts/build-skill-classifier-labels.ts <umacapture の labels.json>');
  process.exit(1);
}

const labels: { 'skill.name': string[] } = JSON.parse(readFileSync(input, 'utf8'));
const names = labels['skill.name'];

const data = loadGameData();
const byNormalizedName = new Map<string, string[]>();
for (const skill of data.skills) {
  const key = normalizeSkillName(skill.name);
  const ids = byNormalizedName.get(key) ?? [];
  ids.push(skill.id);
  byNormalizedName.set(key, ids);
}

const unmatched: string[] = [];
const map = names.map((name) => {
  const ids = byNormalizedName.get(normalizeSkillName(name));
  if (ids === undefined) {
    unmatched.push(name);
    return null;
  }
  // 固有と継承で名前が同じものが 266 件ある。継承版（ID が "9"始まり）を選ぶ。
  // 「スキル」画面に並ぶのはどちらも同じ見た目で区別が付かないため、
  // 一覧に出す慣習に合わせて継承版を優先する。
  return ids.find((id) => id.startsWith('9')) ?? ids[0]!;
});

const target = new URL('../apps/api/assets/skill-classifier/label-map.json', import.meta.url);
writeFileSync(target, JSON.stringify(map));
console.log(`${map.length} 件中 ${map.length - unmatched.length} 件を対応付けた`);
if (unmatched.length > 0) {
  console.log(`対応が無い ${unmatched.length} 件（対戦相手の debuff など、うちのデータに無いもの）:`);
  console.log(unmatched.join('、'));
}
