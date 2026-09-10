import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../../packages/data/src/node.ts';
import { toSerializable } from '../../../packages/sim/src/parallel/protocol.ts';
import type { RaceSetting } from '../../../packages/sim/src/setting.ts';
import type { Config } from '../src/config.ts';
import { detectCpuQuota } from '../src/config.ts';
import { JobRunner, QueueFullError } from '../src/jobs.ts';
import { checkRequest, RequestError } from '../src/request.ts';

const data = loadGameData();

function setting(): RaceSetting {
  return {
    uma: {
      charaName: '', speed: 1200, stamina: 1000, power: 900, guts: 600, wisdom: 900,
      condition: 'BEST', style: 'SEN', distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
      popularity: 1, gateNumber: 5, uniqueLevel: 6,
    },
    track: { location: 10006, course: 10606, condition: 1, gateCount: 9 },
    skills: [],
    skillActivateAdjustment: 'NONE',
    randomPosition: 'RANDOM',
    debuffCounts: {},
    positionKeepMode: 'APPROXIMATE',
    positionKeepRate: 100,
  };
}

function candidateIds(count: number): string[] {
  const names = ['弧線のプロフェッサー', '円弧のマエストロ', '中距離コーナー○', '中距離直線○'];
  return names
    .slice(0, count)
    .map((name) => data.skillsByName.get(name)?.[0]?.id)
    .filter((id): id is string => id !== undefined);
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    base: toSerializable(setting()),
    candidates: candidateIds(2),
    budget: 300,
    seed: 1,
    field: null,
    ...overrides,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    concurrency: 2,
    concurrencySource: 'env',
    maxRunning: 1,
    maxQueued: 2,
    maxRacesPerJob: 2_000_000,
    jobTtlMs: 60_000,
    staticRoot: null,
    tessdataPath: null,
    maxImageBytes: 8 * 1024 * 1024,
    ocrThreshold: 128,
    ...overrides,
  };
}

const settle = async (runner: JobRunner, id: string, timeoutMs = 100_000) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const job = runner.get(id)!;
    if (job.status !== 'queued' && job.status !== 'running') return job;
    if (Date.now() > until) throw new Error(`終わらない: ${job.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('コンテナの CPU 上限', () => {
  it('cgroup v2 のクォータをコア数として読む', () => {
    const read = (p: string) => (p === '/sys/fs/cgroup/cpu.max' ? '200000 100000' : null);
    expect(detectCpuQuota(read)).toBe(2);
  });

  it('上限なし（max）は null になる', () => {
    const read = (p: string) => (p === '/sys/fs/cgroup/cpu.max' ? 'max 100000' : null);
    expect(detectCpuQuota(read)).toBeNull();
  });

  it('cgroup v1 の書式も読む', () => {
    const read = (p: string) =>
      p === '/sys/fs/cgroup/cpu/cpu.cfs_quota_us' ? '150000'
      : p === '/sys/fs/cgroup/cpu/cpu.cfs_period_us' ? '100000'
      : null;
    expect(detectCpuQuota(read)).toBe(1.5);
  });

  it('cgroup が読めなければ null になる', () => {
    expect(detectCpuQuota(() => null)).toBeNull();
  });
});

describe('要求の検査', () => {
  it('通る要求はそのまま解決する', () => {
    const resolved = checkRequest(body(), data);
    expect(resolved.candidates).toHaveLength(2);
    expect(resolved.field).toBeNull();
    // system を渡さなければ既定が入る
    expect(resolved.system.staminaKeepRate).toBeCloseTo(0.9);
  });

  it('知らないスキルは弾く', () => {
    expect(() => checkRequest(body({ candidates: ['そんなものはない'] }), data)).toThrow(RequestError);
  });

  it('候補が空なら弾く', () => {
    expect(() => checkRequest(body({ candidates: [] }), data)).toThrow(RequestError);
  });

  it('非有限の数値は弾く', () => {
    expect(() => checkRequest(body({ budget: Number.NaN }), data)).toThrow(RequestError);
  });

  it('知らないコースは弾く', () => {
    const broken = body();
    const base = broken['base'] as { track: { course: number } };
    broken['base'] = { ...base, track: { ...base.track, course: 999999 } };
    expect(() => checkRequest(broken, data)).toThrow(RequestError);
  });

  it('field は頭数だけ受け取り、相手の中身はこちらで作る', () => {
    const resolved = checkRequest(body({ field: { gateCount: 9 } }), data);
    expect(resolved.field?.samples).toBe(64);
    expect(resolved.field?.profile.uma.speed).toBeGreaterThan(0);
  });

  it('stages は増加する順でなければ弾く', () => {
    expect(() => checkRequest(body({ stages: [600, 200] }), data)).toThrow(RequestError);
  });
});

describe('ジョブ', () => {
  it('走らせると結果が入る', async () => {
    const runner = new JobRunner(config(), data);
    const job = runner.submit(checkRequest(body({ stages: [40, 80] }), data));
    const done = await settle(runner, job.id);
    expect(done.status).toBe('done');
    expect(done.result?.best).toBeDefined();
    expect(done.races).toBeGreaterThan(0);
    expect(done.progress.length).toBeGreaterThan(0);
  }, 120_000);

  it('レース数の上限を超えたら打ち切る', async () => {
    const runner = new JobRunner(config({ maxRacesPerJob: 100 }), data);
    const job = runner.submit(checkRequest(body({ stages: [200, 600] }), data));
    const done = await settle(runner, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('上限');
  }, 120_000);

  it('待ち行列がいっぱいなら受け付けを断る', () => {
    const runner = new JobRunner(config({ maxQueued: 1 }), data);
    const request = checkRequest(body({ stages: [40, 80] }), data);
    runner.submit(request); // すぐ走り出すので待ち行列は空く
    runner.submit(request); // これが待ちに入る
    expect(() => runner.submit(request)).toThrow(QueueFullError);
  });

  it('待っているジョブを消せる', () => {
    const runner = new JobRunner(config(), data);
    const request = checkRequest(body({ stages: [40, 80] }), data);
    runner.submit(request);
    const queued = runner.submit(request);
    expect(runner.cancel(queued.id)).toBe(true);
    expect(runner.get(queued.id)?.status).toBe('cancelled');
  });

  it('保持期間を過ぎた終了済みのジョブは消える', async () => {
    const runner = new JobRunner(config({ jobTtlMs: 1 }), data);
    const job = runner.submit(checkRequest(body({ stages: [40, 80] }), data));
    await settle(runner, job.id);
    runner.sweep(Date.now() + 1000);
    expect(runner.get(job.id)).toBeUndefined();
  }, 120_000);
});
