import { useId, useMemo, useRef, useState } from 'react';
import type { Style } from '../../../../packages/sim/src/data/constants.ts';
import { listIndividuals, type Individual } from '../individualsApi.ts';
import {
  estimateMulti,
  gameData,
  MAX_MULTI_GATE_COUNT,
  MIN_MULTI_GATE_COUNT,
  skillChoices,
  useStore,
  visibleOpponents,
} from '../store.ts';
import { formatDuration } from '../format.ts';
import { NO_CHARA, rarityLabel, shortCharaName, skillIndex } from '../skills.ts';
import { CancelButton, Explain, HorizontalScroll, Panel, SkillChip, UniqueLevelSelect } from './Inputs.tsx';
import { EntryName, MultiRaceDetail, MultiTrialPicker } from './MultiRace.tsx';

const fieldCls = 'w-full rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm';
const STYLES: Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];
const STYLE_LABEL: Record<string, string> = { NIGE: '逃げ', SEN: '先行', SASI: '差し', OI: '追込' };
const STAT_KEYS = ['speed', 'stamina', 'power', 'guts', 'wisdom'] as const;
type StatKey = (typeof STAT_KEYS)[number];
const STAT_LABEL: Record<StatKey, string> = {
  speed: 'スピード',
  stamina: 'スタミナ',
  power: 'パワー',
  guts: '根性',
  wisdom: '賢さ',
};
/** 出走表の列の数。開いた行（編集と個体選び）はこの幅いっぱいに取る。 */
const COLUMNS = 10;
/**
 * 開いた行の中身の幅。
 *
 * 開いた行は表の幅いっぱいに取るので、狭い幅では表と一緒に横に長くなり、
 * 選択欄の右端や候補のレア度が画面の外に出る。中身は横スクロールの入れ物
 * （@container）の見えている幅に収め、表を横に送っても左に留める。
 * 広い幅では選択欄が間延びしないよう 36rem で止める。1rem は td の左右の余白。
 */
const openRowCls = 'sticky left-0 max-w-[min(36rem,calc(100cqw_-_1rem))]';

/**
 * 出走頭数の選択肢。2 から 18 頭。
 *
 * 9 頭と 12 頭は、その頭数で走るイベントの名前を添える。17 個のボタンに
 * すると幅 390 であふれるので select にする。
 */
const GATE_COUNTS = Array.from(
  { length: MAX_MULTI_GATE_COUNT - MIN_MULTI_GATE_COUNT + 1 },
  (_, i) => MIN_MULTI_GATE_COUNT + i,
);
const GATE_COUNT_EVENT: Readonly<Record<number, string>> = {
  9: 'チャンピオンズミーティング',
  12: 'リーグオブヒーローズ',
};
function gateCountLabel(count: number): string {
  const event = GATE_COUNT_EVENT[count];
  return event === undefined ? `${count} 頭` : `${count} 頭（${event}）`;
}

/** 保存した日時。表示は日本時間で、年は省く。読めなければ空にする。 */
function savedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
/**
 * 率の表示。数として読めない値は「—」にする。2 頭立ての 3 着以内のように、
 * 頭数が足りずに率が定まらないとき、NaN をそのまま画面に出さない。
 */
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)} %` : '—');

/** 選んでいないときの表記。 */
const UNSELECTED = 'キャラ未選択';

/**
 * キャラの短い名前。選んでいなければ「キャラ未選択」を弱い色で出す。
 *
 * 読むだけの所（自分の行、個体の一覧）では ink3 で空値と分かるようにする。
 * 押せるボタンの中では ink2 にする。ink3 は 12px の文字で AA に届かず、
 * 押せない文字と同じ色になって、押せることが伝わらない。
 */
function CharaName({ charaName, tone = 'muted' }: { charaName: string; tone?: 'muted' | 'control' }) {
  const name = shortCharaName(charaName);
  if (name !== '') return <>{name}</>;
  return <span className={`font-normal ${tone === 'control' ? 'text-ink2' : 'text-ink3'}`}>{UNSELECTED}</span>;
}

/**
 * 出走の番号の欄。表を横に送っても左に残し、どの行を触っているかを見失わせない。
 * 地の色を塗るのは、下を流れる欄の文字が透けないようにするため。
 */
const numberCellCls = 'num sticky left-0 z-[1] bg-paper py-1 pr-3 text-ink3';

/** 開閉する行の目印。見出しを畳める区切り（Inputs.tsx の Panel）と同じ形にする。 */
function Disclosure({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={`flex-none text-ink2 ${open ? 'rotate-90' : ''}`}
      aria-hidden="true"
    >
      <path d="M6.5 4 10.5 8 6.5 12" />
    </svg>
  );
}

/**
 * 出走表の 1 行目。自分の設定を読むだけの行で、編集は設定の面でする。
 *
 * ステータスを数値の入力にしないのは、同じ値を 2 か所で書き換えられるように
 * しないためである。色だけでなく、太字と「自分」の文字で相手の行と分ける。
 */
function SelfRow() {
  const uma = useStore((s) => s.uma);
  const skillCount = useStore((s) => s.skillIds.length);
  const setTab = useStore((s) => s.setTab);
  return (
    <tr className="border-t border-rule2 font-bold">
      <td className={numberCellCls}>1</td>
      <td className="whitespace-nowrap py-1 pr-3">
        {/* 相手の行は名前の前に開閉の印がある。同じ幅を空けて、名前の頭を揃える */}
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="w-2.5 flex-none" />
          <span>
            自分（<CharaName charaName={uma.charaName} />）
          </span>
        </span>
      </td>
      <td className="whitespace-nowrap pr-2">{STYLE_LABEL[uma.style] ?? uma.style}</td>
      {STAT_KEYS.map((key) => (
        <td key={key} className="pr-1 text-right">
          {/* 相手の行の入力欄と桁の位置を揃える（幅と右の余白を同じにする） */}
          <span className="num inline-block w-16 pr-[5px]">{uma[key]}</span>
        </td>
      ))}
      <td className="num pl-3 pr-2 text-right">{skillCount}</td>
      <td className="pl-2">
        {/* 文字のリンクは acc-ink にする。s1 は図の系列の色で、12px の文字では AA に届かない */}
        <button
          type="button"
          className="whitespace-nowrap text-xs font-normal text-acc-ink underline"
          onClick={() => setTab('settings')}
        >
          設定で変更
        </button>
      </td>
    </tr>
  );
}

interface OpponentRowProps {
  readonly id: number;
  /** 相手の中での並び（0 始まり）。出走の番号は index + 2。 */
  readonly index: number;
  /** null は未取得。取得済みなら（空でも）配列になる。 */
  readonly savedIndividuals: readonly Individual[] | null;
  readonly savedMessage: string | null;
  readonly onRequestSaved: () => void;
}

/**
 * 相手 1 頭ぶんの行。脚質とステータスは行の中で直に変える。
 * キャラとスキルは名前を押して開いた行で、個体選びは「個体から選択」で開いた行で変える。
 */
function OpponentRow({ id, index, savedIndividuals, savedMessage, onRequestSaved }: OpponentRowProps) {
  const opponent = useStore((s) => s.opponents.find((o) => o.id === id));
  const setOpponent = useStore((s) => s.setOpponent);
  const setFromIndividual = useStore((s) => s.setOpponentFromIndividual);
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const editorId = useId();
  const pickerId = useId();
  // 個体を選ぶと一覧ごと消えるので、フォーカスを開いたボタンに戻す。
  // 戻さないと body に落ち、キーボードではページの頭から辿り直すことになる。
  const pickerButton = useRef<HTMLButtonElement>(null);

  if (opponent === undefined) return null;
  const uma = opponent.uma;
  const number = index + 2;
  const shownName = shortCharaName(uma.charaName) || UNSELECTED;

  return (
    <>
      <tr className="border-t border-rule2">
        <td className={numberCellCls}>{number}</td>
        <td className="py-1 pr-3">
          {/*
            押すとキャラとスキルの編集が開くことは、読み上げの名前で言う（見える説明は足さない）。
            18 頭では同じ表記のボタンが並ぶので、どの出走かも名前に入れる。
          */}
          <button
            type="button"
            className="flex items-center gap-1 whitespace-nowrap text-left underline decoration-ink3 underline-offset-2"
            aria-label={`出走 ${number} のキャラとスキル（${shownName}）`}
            aria-expanded={open}
            aria-controls={open ? editorId : undefined}
            onClick={() => setOpen(!open)}
          >
            <Disclosure open={open} />
            <CharaName charaName={uma.charaName} tone="control" />
          </button>
        </td>
        <td className="pr-2">
          {/* 幅を決めておく。成り行きの幅では「差し」の字が欄の右で切れる */}
          <select
            className="w-[4.5rem] rounded-sm border border-rule2 bg-surface px-1 py-0.5 text-xs"
            aria-label={`出走 ${number} の脚質`}
            value={uma.style}
            onChange={(e) => setOpponent(id, { style: e.target.value as Style })}
          >
            {STYLES.map((style) => (
              <option key={style} value={style}>
                {STYLE_LABEL[style]}
              </option>
            ))}
          </select>
        </td>
        {STAT_KEYS.map((key) => (
          <td key={key} className="pr-1 text-right">
            <input
              type="number"
              className="num w-16 rounded-sm border border-rule2 bg-surface px-1 py-0.5 text-right text-xs"
              aria-label={`出走 ${number} の${STAT_LABEL[key]}`}
              value={uma[key]}
              min={1}
              max={2500}
              onChange={(e) => setOpponent(id, { [key]: Number(e.target.value) })}
            />
          </td>
        ))}
        <td className="num pl-3 pr-2 text-right">{opponent.skillIds.length}</td>
        <td className="pl-2">
          <button
            ref={pickerButton}
            type="button"
            className="whitespace-nowrap rounded-sm border border-rule2 px-1.5 py-0.5 text-xs"
            aria-label={`出走 ${number} を個体から選択`}
            aria-expanded={pickerOpen}
            aria-controls={pickerOpen ? pickerId : undefined}
            onClick={() => {
              setPickerOpen(!pickerOpen);
              if (!pickerOpen) onRequestSaved();
            }}
          >
            個体から選択
          </button>
        </td>
      </tr>
      {pickerOpen && (
        <tr id={pickerId} className="border-t border-rule2 bg-paper">
          <td colSpan={COLUMNS} className="p-2">
            <div className={openRowCls}>
              {savedIndividuals === null && <p className="text-xs text-ink3">読み込み中…</p>}
              {savedMessage !== null && <p className="text-xs text-ink3">{savedMessage}</p>}
              {savedIndividuals !== null && savedIndividuals.length > 0 && (
                <ul className="max-h-40 overflow-y-auto rounded-sm border border-rule2 text-xs">
                  {savedIndividuals.map((individual) => (
                    <li key={individual.id}>
                      <button
                        type="button"
                        className="flex w-full flex-wrap items-baseline justify-between gap-x-2 px-2 py-1 text-left hover:bg-sunken"
                        onClick={() => {
                          setFromIndividual(id, individual);
                          setPickerOpen(false);
                          pickerButton.current?.focus();
                        }}
                      >
                        <IndividualLine individual={individual} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </td>
        </tr>
      )}
      {open && (
        <tr id={editorId} className="border-t border-rule2 bg-paper">
          <td colSpan={COLUMNS} className="p-2">
            <div className={openRowCls}>
              <OpponentEditor id={id} number={number} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * 保存した個体の一覧の 1 行。主にキャラの名前を出し、脇に構成と保存した日時を添える。
 *
 * 保存名（label）は脚質とステータスから組んだものなので、脇の構成と同じことを
 * 言う。並べると同じ情報が 2 度出るので、名前と構成に分けて出す。
 * 同じ構成を何度か保存すると見分けが付かないので、保存した日時を添える。
 */
function IndividualLine({ individual }: { individual: Individual }) {
  const uma = individual.uma;
  // 名前の無い個体は、持っている固有の持ち主から補う（選んだときと同じ規則）
  const chara = (uma.charaName ?? NO_CHARA) === NO_CHARA ? skillIndex.charaOf(individual.skillIds) : uma.charaName;
  return (
    <>
      <span className="truncate">
        <CharaName charaName={chara} />
      </span>
      {/* 狭い幅では区切りごとに折り返す。語の途中では折らない */}
      <span className="text-ink3">
        <span className="whitespace-nowrap">{STYLE_LABEL[uma.style] ?? uma.style} ・</span>{' '}
        <span className="num whitespace-nowrap">
          {uma.speed}/{uma.stamina}/{uma.power}/{uma.guts}/{uma.wisdom}
        </span>{' '}
        <span className="whitespace-nowrap">
          ・ スキル <span className="num">{individual.skillIds.length}</span> ・
        </span>{' '}
        <span className="num whitespace-nowrap">{savedAt(individual.createdAt)}</span>
      </span>
    </>
  );
}

/**
 * 相手のキャラとスキル。設定の面の「キャラ（固有と進化）」とスキル検索を 1 つにまとめた形。
 *
 * 固有と進化はキャラの側から選ぶ（skills.ts の冒頭）。固有 Lv は固有を持つときしか
 * 効かないので、持たないときは触れないようにする。固有と進化の札は上に出ているので、
 * 選択中の札の並びには出さない（同じものを 2 か所に出さない）。
 *
 * `number` は出走の番号。行を 2 つ開くと同じ名前の欄が 2 組並ぶので、読み上げの
 * 名前にどの出走かを入れる。
 */
function OpponentEditor({ id, number }: { id: number; number: number }) {
  const opponent = useStore((s) => s.opponents.find((o) => o.id === id));
  const setOpponent = useStore((s) => s.setOpponent);
  const setChara = useStore((s) => s.setOpponentChara);
  const toggleSkill = useStore((s) => s.toggleOpponentSkill);
  const [query, setQuery] = useState('');

  const matched = useMemo(() => {
    if (query.trim() === '') return [];
    return skillChoices.filter((c) => c.name.includes(query.trim())).slice(0, 20);
  }, [query]);

  if (opponent === undefined) return null;
  const charaName = opponent.uma.charaName;
  const uniques = skillIndex.uniquesOf(charaName);
  const evos = skillIndex.evosOf(charaName);
  const hasUnique = uniques.some((skill) => opponent.skillIds.includes(skill.id));
  const onChips = new Set([...uniques, ...evos].map((skill) => skill.id));
  const others = opponent.skillIds.filter((skillId) => !onChips.has(skillId));

  return (
    <div className="flex flex-col gap-2">
      <label className="block">
        <span className="block text-xs text-ink3">キャラ（固有と進化）</span>
        <select
          className={fieldCls}
          data-testid="opponent-chara"
          aria-label={`出走 ${number} のキャラ（固有と進化）`}
          value={charaName}
          onChange={(e) => setChara(id, e.target.value)}
        >
          <option value={NO_CHARA}>未選択</option>
          {skillIndex.charas.map((chara) => (
            <option key={chara} value={chara}>
              {chara}
            </option>
          ))}
        </select>
      </label>
      {charaName !== NO_CHARA && (
        <div className="flex flex-wrap items-center gap-1">
          {uniques.map((skill) => (
            <SkillChip
              key={skill.id}
              size="sm"
              skill={skill}
              selected={opponent.skillIds.includes(skill.id)}
              onToggle={() => toggleSkill(id, skill.id)}
            />
          ))}
          <UniqueLevelSelect
            value={opponent.uma.uniqueLevel}
            disabled={!hasUnique}
            ariaLabel={`出走 ${number} の固有Lv`}
            onChange={(level) => setOpponent(id, { uniqueLevel: level })}
          />
          {evos.map((skill) => (
            <SkillChip
              key={skill.id}
              size="sm"
              skill={skill}
              selected={opponent.skillIds.includes(skill.id)}
              onToggle={() => toggleSkill(id, skill.id)}
            />
          ))}
        </div>
      )}
      <div>
        <input
          className={fieldCls}
          placeholder="スキル名で検索"
          aria-label={`出走 ${number} のスキル検索`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {matched.length > 0 && (
          <ul className="mt-1 max-h-32 overflow-y-auto rounded-sm border border-rule2 text-xs">
            {matched.map((skill) => (
              <li key={skill.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-2 py-1 text-left hover:bg-sunken"
                  onClick={() => toggleSkill(id, skill.id)}
                >
                  <span>{skill.name}</span>
                  <span className="text-ink3">
                    {opponent.skillIds.includes(skill.id) ? '選択中' : rarityLabel(skill.rarity)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {others.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {others.map((skillId) => (
            <button
              key={skillId}
              type="button"
              className="rounded-sm border border-rule2 px-2 py-0.5 text-xs"
              onClick={() => toggleSkill(id, skillId)}
              title="クリックで外します。"
            >
              {gameData.skillsById.get(skillId)?.name ?? skillId} ×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function FieldPanel() {
  const remembered = useStore((s) => s.opponents);
  // 頭数は勝率の面の値。コースの欄の頭数（単騎と順位条件の束が使う）とは別である。
  const gateCount = useStore((s) => s.multiGateCount);
  const setGateCount = useStore((s) => s.setMultiGateCount);
  // 走らせるのは覚えている相手の先頭から頭数ぶん。組み立てはセレクタの外で行う。
  const opponents = useMemo(() => visibleOpponents(remembered, gateCount), [remembered, gateCount]);
  const reset = useStore((s) => s.resetOpponents);
  const trials = useStore((s) => s.multiTrials);
  const setTrials = useStore((s) => s.setMultiTrials);
  const run = useStore((s) => s.runMulti);
  const running = useStore((s) => s.multiRunning);
  const progress = useStore((s) => s.multiProgress);
  const busy = useStore((s) => s.running || s.optimizeRunning);
  const result = useStore((s) => s.multiResult);
  // 全頭同時は 1 試行が単騎の 10 倍ほどかかる。押す前に待ち時間を出す。
  // 組み立てはセレクタの外で行う（Inputs.tsx の RunPanel と同じ理由）。
  const pace = useStore((s) => s.pace);
  const estimate = useMemo(
    () => estimateMulti({ pace, multiGateCount: gateCount, multiTrials: trials }),
    [pace, gateCount, trials],
  );

  // 保存済み個体は行ごとではなく面全体で 1 回だけ取りに行く。行ごとに
  // 叩くと、開くたびに同じ一覧を頭数ぶん取りに行くことになる。
  const [savedIndividuals, setSavedIndividuals] = useState<readonly Individual[] | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  // 開くたびに取り直す。1 度取った一覧を使い回すと、面を開いたまま
  // ヘッダから保存した個体が出てこない（docs/ui-audit-race-emulator.md 第3節 C-4）。
  // 取り直しているあいだは前の一覧を出したままにする。
  const loadSavedIndividuals = () => {
    setSavedMessage(null);
    listIndividuals()
      .then((items) => {
        setSavedIndividuals(items);
        setSavedMessage(items.length === 0 ? '保存された個体がまだありません。' : null);
      })
      .catch((error: unknown) => {
        setSavedMessage(error instanceof Error ? error.message : String(error));
      });
  };

  return (
    <>
      {/* 勝率の面の主役は結果（着順）。入力の出走表はカードにせず線の区切りにする（#101） */}
      <Panel title="出走表" variant="plain">
        {/* 頭数は下の選択欄が出しているので、ここでは繰り返さない */}
        <p className="text-xs text-ink3">
          出走する全頭を同時に走らせ、着順の分布と勝率を出します。
          試行回数はここで指定し、シードは実行バーの値を使います。
        </p>
        <Explain className="mt-1">
          <p>
            相手は自分の走りに反応し、位置取りも相手を見て決まります。
            この面は上の実行バーとは別に動き、「順位条件を判定する」の指定は使いません（順位は実際の位置から決まります）。
            枠番は空いているところから配ります。
          </p>
          <p>
            ここの出走頭数はこの面だけの値で、設定の面のコースの出走頭数（単騎の実行と順位条件の判定が使う）とは別です。
            順位率の条件（上位の何割にいるかで決まる条件）の境界は、9 頭と 12 頭ではスキルデータの注記の値を使います。
            それ以外の頭数では、その値から式で延ばした近似の境界で判定します。ゲームとは突き合わせていません。
          </p>
          <p>
            頭数を減らしても、手を入れた相手は覚えていて、増やすと戻ります。
            手を入れていない相手は、頭数に合わせて既定の相手に入れ替わります。
            「相手の初期化」を押すと、覚えている相手も消えます。
          </p>
        </Explain>
        <label className="block">
          <span className="block text-xs text-ink3">出走頭数</span>
          <select
            className="rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm"
            data-testid="multi-gate-count"
            value={gateCount}
            onChange={(e) => setGateCount(Number(e.target.value))}
          >
            {GATE_COUNTS.map((count) => (
              <option key={count} value={count}>
                {gateCountLabel(count)}
              </option>
            ))}
          </select>
        </label>
        {/*
          relative は、見出しの sr-only（absolute）をこの入れ物の中に置くため。
          無いと横スクロールの外に置かれ、狭い幅でページごと横にあふれる。
          @container は、開いた行の中身を見えている幅に収めるため（openRowCls）。
        */}
        <HorizontalScroll className="relative @container">
          <table className="w-full text-xs" data-testid="multi-entries">
            <thead className="text-ink3">
              <tr>
                {/* 番号の欄は横に送っても左に残す（numberCellCls と同じ） */}
                <th className="sticky left-0 z-[1] whitespace-nowrap bg-paper pb-1 pr-3 text-left">出走</th>
                <th className="whitespace-nowrap pb-1 pr-3 text-left">ウマ娘</th>
                <th className="whitespace-nowrap pb-1 pr-2 text-left">脚質</th>
                {STAT_KEYS.map((key) => (
                  <th key={key} className="whitespace-nowrap pb-1 pr-1 text-right">
                    {STAT_LABEL[key]}
                  </th>
                ))}
                <th className="whitespace-nowrap pb-1 pl-3 pr-2 text-right">スキル</th>
                <th className="w-full pb-1">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <SelfRow />
              {opponents.map((opponent, index) => (
                <OpponentRow
                  key={opponent.id}
                  id={opponent.id}
                  index={index}
                  savedIndividuals={savedIndividuals}
                  savedMessage={savedMessage}
                  onRequestSaved={loadSavedIndividuals}
                />
              ))}
            </tbody>
          </table>
        </HorizontalScroll>
        <div className="mt-1 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block text-xs text-ink3">試行回数</span>
            <input
              type="number"
              className="num w-28 rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm"
              value={trials}
              min={1}
              max={50000}
              step={100}
              onChange={(e) => setTrials(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className="rounded-sm bg-primary-bg px-4 py-1.5 text-sm text-primary-fg disabled:opacity-50"
            onClick={() => void run()}
            disabled={running || busy}
          >
            {running ? '計算中' : '勝率の計算'}
          </button>
          {running ? (
            <>
              <CancelButton />
              <span className="text-sm text-ink3">
                <span className="num">{progress}</span> / <span className="num">{trials}</span>
              </span>
            </>
          ) : (
            <span
              className="pb-1.5 text-xs text-ink3"
              data-testid="multi-estimate"
              title={
                estimate.measured
                  ? '直前の実測から出しています。'
                  : '作り付けの目安です。1 回走らせると実測に置き換わります。'
              }
            >
              {estimate.measured ? '見込み' : '目安'} 約 {formatDuration(estimate.ms)}
            </span>
          )}
          <button type="button" className="text-xs text-ink3 underline" onClick={reset}>
            相手の初期化
          </button>
        </div>
      </Panel>

      {result !== null && (
        <Panel title="着順">
          {result.cancelled && (
            <p className="mb-2 text-xs text-ink3">
              中断したので、終わった {result.trials} 試行だけを集計しています。
            </p>
          )}
          {/*
            狭い幅では着順の分布の帯のぶん横にはみ出す。横に送って読む表なので、欄は折り返さず、
            はみ出すときはその旨を下に書く（HorizontalScroll）。出走の欄は横に送っても左に残す。
            この区画は枠のある箱（surface）なので、残す欄の地も surface で塗る。
            relative は、左に残す欄（sticky）の重なりをこの入れ物の中に閉じるため。
          */}
          <HorizontalScroll className="relative">
            <table className="w-full text-xs">
              <thead className="text-ink3">
                <tr>
                  <th className="sticky left-0 z-[1] whitespace-nowrap bg-surface pb-1 pr-3 text-left">出走</th>
                  <th className="whitespace-nowrap pb-1 pl-2 text-right">勝率</th>
                  <th className="whitespace-nowrap pb-1 pl-2 text-right">連対率</th>
                  <th className="whitespace-nowrap pb-1 pl-2 text-right">複勝率</th>
                  <th className="whitespace-nowrap pb-1 pl-2 text-right">平均着順</th>
                  <th className="whitespace-nowrap pb-1 pl-2 text-right">平均タイム</th>
                  <th className="whitespace-nowrap pb-1 pl-3 text-left">着順の分布</th>
                </tr>
              </thead>
              <tbody>
                {result.summaries.map((s) => {
                  const self = s.index === 0;
                  return (
                    <tr
                      key={s.index}
                      className={`border-t border-rule2 ${self ? 'font-bold' : ''}`}
                    >
                      {/* 呼び名は走らせたときのもの。あとで相手を触っても行の名前はずれない */}
                      <td className="sticky left-0 z-[1] whitespace-nowrap bg-surface py-1 pr-3">
                        <EntryName index={s.index} names={result.names} />
                      </td>
                      <td className="num whitespace-nowrap pl-2 text-right">{pct(s.winRate)}</td>
                      <td className="num whitespace-nowrap pl-2 text-right">{pct(s.quinellaRate)}</td>
                      <td className="num whitespace-nowrap pl-2 text-right">{pct(s.showRate)}</td>
                      <td className="num whitespace-nowrap pl-2 text-right">{s.meanOrder.toFixed(2)}</td>
                      <td className="num whitespace-nowrap pl-2 text-right">{s.meanTime.toFixed(3)}</td>
                      <td className="pl-3">
                        <OrderBar counts={s.counts} trials={s.trials} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </HorizontalScroll>
          {/* 頭数は走らせたときの値。頭数を変えても前の結果は残るので、いまの選択欄の値は使わない */}
          <p className="mt-2 text-xs text-ink3" data-testid="multi-result-meta">
            <span className="num">{result.gateCount}</span> 頭 ・ <span className="num">{result.trials}</span> 試行 /{' '}
            <span className="num">{(result.elapsedMs / 1000).toFixed(1)}</span> 秒
          </p>
          {/* 勝率の次に来る問いは「なぜこの試行で負けたのか」である。#57 */}
          <MultiTrialPicker />
        </Panel>
      )}

      <MultiRaceDetail />
    </>
  );
}

/**
 * 着順の分布を 1 行の帯で示す。
 * 左が 1 着で、右にいくほど後ろになる。濃さで着順を表す。
 */
function OrderBar({ counts, trials }: { counts: readonly number[]; trials: number }) {
  if (trials === 0) return null;
  const last = counts.length - 1;
  return (
    <div className="flex h-3 w-40 overflow-hidden rounded-sm" role="img" aria-label="着順の分布">
      {counts.slice(1).map((count, i) => {
        const order = i + 1;
        const share = count / trials;
        if (share <= 0) return null;
        // 1 着を最も濃く、最下位を最も薄くする
        const alpha = 0.15 + 0.85 * (1 - (order - 1) / Math.max(1, last - 1));
        return (
          <div
            key={order}
            style={{ width: `${100 * share}%`, backgroundColor: `color-mix(in srgb, var(--color-s1) ${100 * alpha}%, transparent)` }}
            title={`${order} 着 ${(100 * share).toFixed(1)} %`}
          />
        );
      })}
    </div>
  );
}
