import type { LineupEntry } from '../../src/schemas.ts';

/**
 * 会話の中で、育成ウマ娘の詳細画面の画像 11 枚から書き起こした出走表。
 * 値は画像のとおりで、ステータスのランク文字（statusRank）も付けてある。
 *
 * ファインモーションとスーパークリークには、他馬に効くデバフ（逃げけん制、追込ためらい、
 * 先行ためらい）が付いている。画像には写っているが、データに無く、解決できない。
 * 解決できないスキルが入った出走表の扱いを確かめるために、そのまま残してある。
 */
export const LINEUP_11: LineupEntry[] = [
  {
    "name": "ファインモーション",
    "chara": "ファインモーション",
    "status": {
      "speed": 1203,
      "stamina": 688,
      "power": 915,
      "guts": 543,
      "wisdom": 749
    },
    "statusRank": {
      "speed": "U",
      "stamina": "B",
      "power": "A+",
      "guts": "C+",
      "wisdom": "B+"
    },
    "aptitude": {
      "surface": {
        "turf": "A",
        "dirt": "E"
      },
      "distance": {
        "short": "F",
        "mile": "A",
        "mid": "S",
        "long": "C"
      },
      "style": {
        "nige": "D",
        "sen": "A",
        "sasi": "E",
        "oi": "C"
      }
    },
    "unique": {
      "name": "Fairy tale",
      "level": 4
    },
    "skills": [
      "勝利の鼓動",
      "夏空ハレーション",
      "あっぱれ大盤振る舞い！",
      "右回り◎",
      "秋ウマ娘◎",
      "コーナー巧者○",
      "鋼の意志",
      "テンポアップ",
      "中距離直線◎",
      "中距離コーナー◎",
      "先行コーナー◎",
      "逃げけん制",
      "追込ためらい"
    ],
    "rating": 16990
  },
  {
    "name": "スーパークリーク",
    "chara": "スーパークリーク",
    "status": {
      "speed": 1252,
      "stamina": 615,
      "power": 883,
      "guts": 690,
      "wisdom": 836
    },
    "statusRank": {
      "speed": "U",
      "stamina": "B",
      "power": "A",
      "guts": "B",
      "wisdom": "A"
    },
    "aptitude": {
      "surface": {
        "turf": "S",
        "dirt": "G"
      },
      "distance": {
        "short": "G",
        "mile": "G",
        "mid": "S",
        "long": "A"
      },
      "style": {
        "nige": "D",
        "sen": "A",
        "sasi": "B",
        "oi": "G"
      }
    },
    "unique": {
      "name": "ピュリティオブハート",
      "level": 6
    },
    "skills": [
      "右回り○",
      "秋ウマ娘○",
      "弧線のプロフェッサー",
      "癒しのマエストロ",
      "中距離コーナー○",
      "先行直線○",
      "先行コーナー○",
      "あま～い幻惑",
      "先行のコツ○",
      "地固め",
      "尻尾の滝登り",
      "遊びはおしまいっ！",
      "食らいつき",
      "王手",
      "品行方正",
      "怜悧清澄",
      "憧れを越えて",
      "心惹かれて",
      "力業",
      "華麗な足取り",
      "気持ちを乗せて",
      "前人未到",
      "レースの真髄・体",
      "レースの真髄・力",
      "恩返し、召し上がれ",
      "先行ためらい"
    ],
    "rating": 19919
  },
  {
    "name": "ツルマルツヨシ",
    "chara": "ツルマルツヨシ",
    "status": {
      "speed": 1278,
      "stamina": 565,
      "power": 973,
      "guts": 702,
      "wisdom": 884
    },
    "statusRank": {
      "speed": "U",
      "stamina": "C+",
      "power": "A+",
      "guts": "B+",
      "wisdom": "A"
    },
    "aptitude": {
      "surface": {
        "turf": "A",
        "dirt": "E"
      },
      "distance": {
        "short": "F",
        "mile": "D",
        "mid": "S",
        "long": "C"
      },
      "style": {
        "nige": "G",
        "sen": "A",
        "sasi": "A",
        "oi": "E"
      }
    },
    "unique": {
      "name": "燃え盛るは絶対の意志",
      "level": 5
    },
    "skills": [
      "勝利の鼓動",
      "Joy to the World",
      "右回り◎",
      "コーナー回復○",
      "鋼の意志",
      "ペースキープ",
      "中距離直線◎",
      "迸る月流星",
      "先行直線◎",
      "千辛万苦切り裂く刃",
      "地固め",
      "王手",
      "光差す方へ",
      "勇気の一歩",
      "華麗な足取り",
      "素質の証明",
      "レースの真髄・速",
      "レースの真髄・体",
      "レースの真髄・根",
      "レースの真髄・心"
    ],
    "rating": 18776
  },
  {
    "name": "ツインターボ",
    "chara": "ツインターボ",
    "status": {
      "speed": 1276,
      "stamina": 890,
      "power": 805,
      "guts": 723,
      "wisdom": 747
    },
    "statusRank": {
      "speed": "U",
      "stamina": "A",
      "power": "A",
      "guts": "B+",
      "wisdom": "B+"
    },
    "aptitude": {
      "surface": {
        "turf": "A",
        "dirt": "A"
      },
      "distance": {
        "short": "G",
        "mile": "A",
        "mid": "A",
        "long": "E"
      },
      "style": {
        "nige": "A",
        "sen": "G",
        "sasi": "G",
        "oi": "G"
      }
    },
    "unique": {
      "name": "エンジン全開！大噴射！",
      "level": 6
    },
    "skills": [
      "アングリング×スキーミング",
      "HOP STEP♪LOCK ON!",
      "大逃げ",
      "右回り○",
      "秋ウマ娘○",
      "好転一息",
      "コンセントレーション",
      "臨機応変",
      "ターボについてこーい！",
      "急ぎ足",
      "中距離直線○",
      "逃げコーナー○",
      "危険回避",
      "トップランナー",
      "勢い任せ",
      "スリーセブン",
      "地固め",
      "尻尾上がり",
      "一番乗り",
      "連鎖反応",
      "悠々自適",
      "限界の先へ"
    ],
    "rating": 19514
  },
  {
    "name": "ミスターシービー",
    "chara": "ミスターシービー",
    "status": {
      "speed": 1255,
      "stamina": 691,
      "power": 952,
      "guts": 661,
      "wisdom": 876
    },
    "statusRank": {
      "speed": "U",
      "stamina": "B",
      "power": "A+",
      "guts": "B",
      "wisdom": "A"
    },
    "aptitude": {
      "surface": {
        "turf": "A",
        "dirt": "G"
      },
      "distance": {
        "short": "G",
        "mile": "B",
        "mid": "A",
        "long": "A"
      },
      "style": {
        "nige": "G",
        "sen": "E",
        "sasi": "A",
        "oi": "S"
      }
    },
    "unique": {
      "name": "叙情、旅路の果てに",
      "level": 6
    },
    "skills": [
      "Nemesis",
      "我が覇道、阻むものなし",
      "根幹距離○",
      "コーナー回復○",
      "直線回復",
      "垂れウマ回避",
      "踊る脚色",
      "中距離コーナー○",
      "軽やかステップ",
      "追込直線○",
      "追込コーナー○",
      "強攻策",
      "下り坂巧者",
      "天翔る足取り",
      "快速",
      "息抜き上手",
      "限界の先へ",
      "レースの真髄・体"
    ],
    "rating": 18233
  },
  {
    "name": "フジキセキ",
    "chara": "フジキセキ",
    "status": {
      "speed": 1295,
      "stamina": 757,
      "power": 834,
      "guts": 657,
      "wisdom": 776
    },
    "statusRank": {
      "speed": "U",
      "stamina": "B+",
      "power": "A",
      "guts": "B",
      "wisdom": "B+"
    },
    "aptitude": {
      "surface": {
        "turf": "A",
        "dirt": "F"
      },
      "distance": {
        "short": "B",
        "mile": "A",
        "mid": "S",
        "long": "E"
      },
      "style": {
        "nige": "C",
        "sen": "A",
        "sasi": "C",
        "oi": "G"
      }
    },
    "unique": {
      "name": "煌星のヴォードヴィル",
      "level": 6
    },
    "skills": [
      "エンターテイナー",
      "中距離直線○",
      "中距離コーナー○",
      "先行直線○",
      "先行コーナー○",
      "王手",
      "揺るがぬ信念",
      "光差す方へ",
      "正々堂々",
      "パスファインダー",
      "勇気の一歩",
      "心惹かれて",
      "気ままな足取り",
      "迸る気迫",
      "余勢を駆って",
      "悠々自適",
      "清麗高雅",
      "素質の証明"
    ],
    "rating": 19357
  },
  {
    "name": "イクノディクタス",
    "chara": "イクノディクタス",
    "status": {
      "speed": 1201,
      "stamina": 824,
      "power": 945,
      "guts": 784,
      "wisdom": 962
    },
    "statusRank": {
      "speed": "U",
      "stamina": "A",
      "power": "A+",
      "guts": "B+",
      "wisdom": "A+"
    },
    "aptitude": {
      "surface": {
        "turf": "A",
        "dirt": "G"
      },
      "distance": {
        "short": "D",
        "mile": "A",
        "mid": "A",
        "long": "C"
      },
      "style": {
        "nige": "D",
        "sen": "A",
        "sasi": "A",
        "oi": "D"
      }
    },
    "unique": {
      "name": "百錬成鋼",
      "level": 5
    },
    "skills": [
      "Faith in the Feral",
      "黄金を訪ねて",
      "恵福バルカローレ",
      "夏雷カスケード！",
      "円弧のマエストロ",
      "徹底管理プラン",
      "尻尾の滝登り",
      "ありったけ",
      "鉄火花",
      "自制心",
      "進出開始",
      "込み上げる熱",
      "一歩ずつ前へ",
      "突破口",
      "心惹かれて",
      "勝負を懸けて",
      "清麗高雅",
      "連綿"
    ],
    "rating": 19397
  },
  {
    "name": "エルコンドルパサー",
    "chara": "エルコンドルパサー",
    "status": {
      "speed": 1222,
      "stamina": 913,
      "power": 871,
      "guts": 603,
      "wisdom": 831
    },
    "statusRank": {
      "speed": "U",
      "stamina": "A+",
      "power": "A",
      "guts": "B",
      "wisdom": "A"
    },
    "aptitude": {
      "surface": {
        "turf": "A",
        "dirt": "B"
      },
      "distance": {
        "short": "F",
        "mile": "A",
        "mid": "S",
        "long": "B"
      },
      "style": {
        "nige": "E",
        "sen": "A",
        "sasi": "A",
        "oi": "C"
      }
    },
    "unique": {
      "name": "プランチャ☆ガナドール",
      "level": 6
    },
    "skills": [
      "恵福バルカローレ",
      "あっぱれ大盤振る舞い！",
      "Joy to the World",
      "解けぬ結い目",
      "右回り○",
      "根幹距離○",
      "円弧のマエストロ",
      "余裕のパフォーマンス",
      "鷹ノ目",
      "地固め",
      "王手",
      "比類なき",
      "光明",
      "気ままな足取り",
      "迸る気迫",
      "力業",
      "悠々自適",
      "清麗高雅",
      "ただその先へ",
      "素質の証明"
    ],
    "rating": 19409
  },
  {
    "name": "アグネスタキオン",
    "chara": "アグネスタキオン",
    "status": {
      "speed": 1244,
      "stamina": 600,
      "power": 856,
      "guts": 657,
      "wisdom": 1036
    },
    "statusRank": {
      "speed": "U",
      "stamina": "B",
      "power": "A",
      "guts": "B",
      "wisdom": "S"
    },
    "aptitude": {
      "surface": {
        "turf": "A",
        "dirt": "G"
      },
      "distance": {
        "short": "G",
        "mile": "D",
        "mid": "A",
        "long": "A"
      },
      "style": {
        "nige": "E",
        "sen": "S",
        "sasi": "B",
        "oi": "F"
      }
    },
    "unique": {
      "name": "U=ma2",
      "level": 6
    },
    "skills": [
      "セイリオス",
      "あっぱれ大盤振る舞い！",
      "右回り○",
      "ハヤテー文字",
      "垂れウマ回避",
      "効率的休息法",
      "テンポアップ",
      "中距離直線○",
      "中距離コーナー○",
      "可能性の徒",
      "尻尾の滝登り",
      "遊びはおしまいっ！",
      "下り坂巧者",
      "シンギュラリティ",
      "王手",
      "怜悧清澄",
      "前人未到",
      "もう一踏ん張り"
    ],
    "rating": 19314
  },
  {
    "name": "テイエムオペラオー",
    "chara": "テイエムオペラオー",
    "status": {
      "speed": 1216,
      "stamina": 635,
      "power": 768,
      "guts": 507,
      "wisdom": 925
    },
    "statusRank": {
      "speed": "U",
      "stamina": "B",
      "power": "B+",
      "guts": "C+",
      "wisdom": "A+"
    },
    "aptitude": {
      "surface": {
        "turf": "A",
        "dirt": "E"
      },
      "distance": {
        "short": "G",
        "mile": "E",
        "mid": "S",
        "long": "A"
      },
      "style": {
        "nige": "C",
        "sen": "A",
        "sasi": "A",
        "oi": "G"
      }
    },
    "unique": {
      "name": "恵福バルカローレ",
      "level": 4
    },
    "skills": [
      "Peerless Heroine",
      "夏空ハレーション",
      "Joy to the World",
      "ミンナノアタシへ！",
      "右回り○",
      "秋ウマ娘○",
      "円舞曲のマエストロ",
      "中距離コーナー◎",
      "先行コーナー◎",
      "地固め",
      "会心の一歩",
      "アグレッシブ",
      "勇気の一歩",
      "解き放つ情念",
      "気ままな足取り",
      "憂いなし",
      "悠々自適",
      "素質の証明",
      "連綿",
      "レースの真髄・体",
      "レースの真髄・力"
    ],
    "rating": 16875
  },
  {
    "name": "ヒシアマゾン",
    "chara": "ヒシアマゾン",
    "status": {
      "speed": 1319,
      "stamina": 532,
      "power": 837,
      "guts": 628,
      "wisdom": 824
    },
    "statusRank": {
      "speed": "U",
      "stamina": "C+",
      "power": "A",
      "guts": "B",
      "wisdom": "A"
    },
    "aptitude": {
      "surface": {
        "turf": "A",
        "dirt": "C"
      },
      "distance": {
        "short": "D",
        "mile": "A",
        "mid": "S",
        "long": "B"
      },
      "style": {
        "nige": "G",
        "sen": "B",
        "sasi": "C",
        "oi": "A"
      }
    },
    "unique": {
      "name": "タイマン！デッドヒート！",
      "level": 4
    },
    "skills": [
      "レッツ・アナボリック！",
      "彼方、その先へ…",
      "スカーレットリリィの高揚",
      "右回り◎",
      "秋ウマ娘◎",
      "ハヤテー文字",
      "怒濤のポロロッカ",
      "タイマンにかける執念",
      "中距離直線◎",
      "中距離コーナー◎",
      "追込直線◎",
      "追込コーナー◎",
      "ウマ好み",
      "地固め",
      "強攻策",
      "イグニッション",
      "自信家",
      "君臨",
      "垣間見た光",
      "登竜門",
      "捕捉",
      "千鍛万錬",
      "錦上添花",
      "レースの真髄・体"
    ],
    "rating": 19434
  }
];

/** デバフを除いた名前。これらは全部解決できる。 */
export const DEBUFF_NAMES = ['逃げけん制', '追込ためらい', '先行ためらい'];
