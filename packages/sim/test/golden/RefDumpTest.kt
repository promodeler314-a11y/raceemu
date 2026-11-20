package io.github.mee1080.umasim.race.calc2

import io.github.mee1080.umasim.race.data.Condition
import io.github.mee1080.umasim.race.data.CourseCondition
import io.github.mee1080.umasim.race.data.FitRank
import io.github.mee1080.umasim.race.data.PositionKeepMode
import io.github.mee1080.umasim.race.data.RandomPosition
import io.github.mee1080.umasim.race.data.SkillActivateAdjustment
import io.github.mee1080.umasim.race.data.Style
import io.github.mee1080.umasim.race.data2.getSkills
import io.github.mee1080.umasim.race.data2.loadLocalSkillData
import kotlin.math.floor
import kotlin.math.sqrt
import kotlin.test.Test

/**
 * raceemu の packages/sim/test/golden/umasim-reference.json を作るための書き出し。
 * 正本は raceemu の packages/sim/test/golden/RefDumpTest.kt である。
 * 本家のリポジトリには置かず、作り直すときだけ race/src/commonTest/.../calc2/ に置いて回す。
 *
 *   ./gradlew :race:jvmTest --tests '*RefDumpTest*' --rerun-tasks
 *
 * 標準出力に `=== SKILLIDS|DERIVED|TIMES <ラベル>` と `キー=値` の行を出す。
 * 試行回数は環境変数 REF_TRIALS で変えられる（既定 20000）。
 */
class RefDumpTest {

    private val trials = System.getenv("REF_TRIALS")?.toIntOrNull() ?: 20000

    private val referenceSkillNames = listOf(
        "弧線のプロフェッサー",
        "円弧のマエストロ",
        "府中の申し子",
        "根幹距離◎",
        "ノンストップガール",
        "火事場のバ鹿力",
    )

    /** D: 人気条件を無視させる効果（本家 2026-09-28）を通すケース。中距離なので旗が立つ。 */
    private val ignorePopularitySkillNames = listOf(
        "All-in!!",
        "勝負師",
        "伏兵○",
    )

    private fun baseA() = RaceSetting(
        umaStatus = UmaStatus(
            charaName = "T",
            speed = 1200,
            stamina = 1000,
            power = 900,
            guts = 600,
            wisdom = 900,
            condition = Condition.BEST,
            style = Style.SEN,
            distanceFit = FitRank.A,
            surfaceFit = FitRank.A,
            styleFit = FitRank.A,
            popularity = 1,
            gateNumber = 5,
            uniqueLevel = 6,
        ),
        track = Track(location = 10006, course = 10606, condition = CourseCondition.GOOD, gateCount = 9),
        skillActivateAdjustment = SkillActivateAdjustment.NONE,
        randomPosition = RandomPosition.RANDOM,
        positionKeepMode = PositionKeepMode.APPROXIMATE,
        positionKeepRate = 100,
    )

    private fun baseB() = RaceSetting(
        umaStatus = UmaStatus(
            charaName = "T",
            speed = 1400,
            stamina = 800,
            power = 1100,
            guts = 700,
            wisdom = 1000,
            condition = Condition.BEST,
            style = Style.NIGE,
            distanceFit = FitRank.A,
            surfaceFit = FitRank.A,
            styleFit = FitRank.A,
            popularity = 1,
            gateNumber = 3,
            uniqueLevel = 6,
        ),
        track = Track(location = 10001, course = 10101, condition = CourseCondition.GOOD, gateCount = 9),
        skillActivateAdjustment = SkillActivateAdjustment.NONE,
        randomPosition = RandomPosition.RANDOM,
        positionKeepMode = PositionKeepMode.APPROXIMATE,
        positionKeepRate = 100,
    )

    private fun dumpDerived(label: String, setting: RaceSetting) {
        // 参照値は PassiveBonus() 無しで出す（移植側の reference.test.ts も passive 無しで比べる）
        val s = RaceSettingWithPassive(setting, PassiveBonus())
        println("=== DERIVED $label")
        val values = linkedMapOf<String, Any>(
            "courseLength" to s.courseLength.toDouble(),
            "baseSpeed" to s.baseSpeed,
            "modifiedSpeed" to s.modifiedSpeed.toDouble(),
            "modifiedStamina" to s.modifiedStamina.toDouble(),
            "modifiedPower" to s.modifiedPower.toDouble(),
            "modifiedGuts" to s.modifiedGuts.toDouble(),
            "modifiedWisdom" to s.modifiedWisdom.toDouble(),
            "spMax" to s.spMax,
            "spurtSpCoef" to s.spurtSpCoef,
            "temptationRate" to s.temptationRate,
            "maxSpurtSpeed" to s.maxSpurtSpeed,
            "v0" to s.v0,
            "v1" to s.v1,
            "v2" to s.v2,
            "v3" to s.v3,
            "vMinBase" to s.vMinBase,
            "a0" to s.a0,
            "a1" to s.a1,
            "a2" to s.a2,
            "a3" to s.a3,
            "leadCompetitionSpeed" to s.leadCompetitionSpeed,
            "leadCompetitionFrame" to s.leadCompetitionFrame,
            "competeFightSpeed" to s.competeFightSpeed,
            "competeFightAcceleration" to s.competeFightAcceleration,
            "conservePowerAccelerationBase" to s.conservePowerAccelerationBase,
            "conservePowerFrame" to s.conservePowerFrame.toDouble(),
            "positionCompetitionSpeed" to s.positionCompetitionSpeed,
            "positionCompetitionStamina" to s.positionCompetitionStamina.toDouble(),
            "secureLeadSpeed" to s.secureLeadSpeed,
            "secureLeadStamina" to s.secureLeadStamina.toDouble(),
            "staminaLimitBreakSpeed" to s.staminaLimitBreakSpeed,
            "baseLaneChangeTargetSpeed" to s.baseLaneChangeTargetSpeed,
            "positionKeepMinDistance" to s.positionKeepMinDistance,
            "positionKeepMaxDistance" to s.positionKeepMaxDistance,
            "coolDownBaseFrames" to s.coolDownBaseFrames,
            "skillActivateRate" to s.skillActivateRate,
            "wisdomSkillBuff" to (0..3).map { s.wisdomSkillBuff[it]!! },
        )
        values.forEach { (key, value) ->
            val text = if (value is List<*>) value.joinToString(",") else value.toString()
            println("$key=$text")
        }
    }

    private fun quantile(sorted: List<Double>, q: Double): Double {
        // 線形補間（numpy の既定と同じ）
        val pos = (sorted.size - 1) * q
        val lo = floor(pos).toInt()
        val hi = minOf(lo + 1, sorted.size - 1)
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
    }

    private fun dumpTimes(label: String, setting: RaceSetting) {
        val calculator = RaceCalculator(SystemSetting())
        val results = List(trials) { calculator.simulate(setting).first }
        val times = results.map { it.raceTime }.sorted()
        val n = times.size
        val mean = times.sum() / n
        val sd = sqrt(times.sumOf { (it - mean) * (it - mean) } / (n - 1))
        println("=== TIMES $label")
        println("count=${n.toDouble()}")
        println("mean=$mean")
        println("sd=$sd")
        println("stderr=${sd / sqrt(n.toDouble())}")
        println("min=${times.first()}")
        println("p25=${quantile(times, 0.25)}")
        println("median=${quantile(times, 0.5)}")
        println("p75=${quantile(times, 0.75)}")
        println("max=${times.last()}")
        println("maxSpurtRate=${results.count { it.maxSpurt }.toDouble() / n}")
        println("finishRate=${results.count { it.goalSp >= 0.0 }.toDouble() / n}")
    }

    @Test
    fun dump() {
        loadLocalSkillData()
        val a = baseA()
        val b = baseB()
        // 名前が重複する場合は先頭を使う（移植側の reference.test.ts と同じ）
        val skills = referenceSkillNames.map { getSkills(it).first() }
        val c = a.copy(umaStatus = a.umaStatus.copy(hasSkills = skills))

        dumpDerived("A_tokyo2400_sen", a)
        dumpTimes("A_tokyo2400_sen", a)
        dumpDerived("B_sapporo1200_nige", b)
        dumpTimes("B_sapporo1200_nige", b)
        println("=== SKILLIDS C_tokyo2400_sen_skills")
        skills.forEach { println("skill=${it.name}|${it.id}") }
        dumpDerived("C_tokyo2400_sen_skills", c)
        dumpTimes("C_tokyo2400_sen_skills", c)
        val dSkills = ignorePopularitySkillNames.map { getSkills(it).first() }
        val d = a.copy(umaStatus = a.umaStatus.copy(hasSkills = dSkills))
        println("=== SKILLIDS D_tokyo2400_sen_ignore_popularity")
        dSkills.forEach { println("skill=${it.name}|${it.id}") }
        dumpDerived("D_tokyo2400_sen_ignore_popularity", d)
        dumpTimes("D_tokyo2400_sen_ignore_popularity", d)
        println("=== END")
    }
}
