import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 本番のマニフェスト（deploy/k8s.yaml、deploy/sync.yaml、deploy/gate/）どうしの食い違いを見る。
 *
 * 2 つは名前とタグだけで繋がっている。ビルドが置くタグと Deployment が引くタグ、
 * sync.sh が入れ替える Deployment の名前がずれても、どちらも正しい YAML のままで
 * 誰も落ちない。ビルドは毎回成功し、入れ替えも成功し、**古いイメージが動き続ける。**
 *
 * 以前は本番の構成がリポジトリに無く、個体の保存に PVC が無いまま動いていた
 * （docs/deploy.md の 4.3 節）。それもここで見る。
 *
 * YAML のパーサは入れていない（test/workflows.test.ts と同じ理由）。
 */
function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const k8s = read('deploy/k8s.yaml');
const sync = read('deploy/sync.yaml');
const gate = read('deploy/gate/gate.yaml');

/** sync.sh の `NAME="value"` を読む。 */
function shellVar(name: string): string {
  const match = new RegExp(`^ +${name}="([^"]+)"$`, 'm').exec(sync);
  if (match === null) throw new Error(`sync.sh に ${name} が無い`);
  return match[1]!;
}

/** マニフェストから kind の塊を 1 つ取り出す。 */
function blockOf(manifest: string, kind: string): string {
  const block = manifest
    .split('\n---\n')
    .find((part) => new RegExp(`^kind: ${kind}$`, 'm').test(part));
  if (block === undefined) throw new Error(`${kind} が無い`);
  return block;
}

function k8sBlock(kind: string): string {
  return blockOf(k8s, kind);
}

/** env の `- name: X` に続く `value:` を読む。 */
function envValue(block: string, name: string): string {
  const match = new RegExp(`- name: ${name}\\n +value: "?([^"\\n]+)"?`).exec(block);
  if (match === null) throw new Error(`${name} が無い`);
  return match[1]!;
}

describe('本番のマニフェスト', () => {
  it('Deployment はビルドが動かすほうのタグを引く', () => {
    const output = /"name=([^,"]+):__SHORT__,([^,"]+)"/.exec(sync);
    expect(output, 'build-job.yaml の --output が読めない').not.toBeNull();
    const moving = output![2]!;
    expect(moving.startsWith(`${output![1]}:`), 'SHA のタグと動くタグが同じレジストリにある').toBe(true);

    const deployment = k8sBlock('Deployment');
    expect(deployment).toMatch(new RegExp(`^ +image: ${moving.replace(/[.]/g, '\\.')}$`, 'm'));
    // 同じタグのまま中身が変わるので、引き直さないと rollout restart が古いものを立て直す。
    expect(deployment).toMatch(/^ +imagePullPolicy: Always$/m);
  });

  it('sync.sh が入れ替えるのは k8s.yaml の Deployment である', () => {
    const deployment = k8sBlock('Deployment');
    expect(deployment).toMatch(new RegExp(`^  name: ${shellVar('DEPLOY')}$`, 'm'));
    expect(deployment).toMatch(new RegExp(`^  namespace: ${shellVar('NS')}$`, 'm'));
  });

  it('k8s.yaml は sync.sh の印を持たない', () => {
    // 書くと apply のたびに印が巻き戻り、同じ SHA を組み直すことになる。
    expect(k8s).not.toMatch(/^ +raceemu\.dev\/commit:/m);
  });

  it('個体の保存先が PVC にある', () => {
    const deployment = k8sBlock('Deployment');
    const dataDir = /- name: RACEEMU_DATA_DIR\n +value: (\S+)/.exec(deployment);
    expect(dataDir, 'RACEEMU_DATA_DIR が無いと個体はメモリに置かれ、入れ替えのたびに消える').not.toBeNull();
    expect(deployment).toMatch(new RegExp(`mountPath: ${dataDir![1]}$`, 'm'));
    expect(deployment).toMatch(/claimName: raceemu-data/);
    // ReadWriteOnce を新旧の Pod が同時に掴まないよう、止めてから立てる。
    expect(deployment).toMatch(/^ +type: Recreate$/m);
  });

  it('ゲートウェイの上流はアプリの Service である', () => {
    // ずれるとゲートは 502 を返し続ける。どちらのマニフェストも正しいままである。
    const service = k8sBlock('Service');
    const name = /^  name: (\S+)$/m.exec(service)![1];
    const namespace = /^  namespace: (\S+)$/m.exec(service)![1];
    const port = /^ +port: (\d+)$/m.exec(service)![1];
    const deployment = blockOf(gate, 'Deployment');
    expect(envValue(deployment, 'UPSTREAM_HOST')).toBe(`${name}.${namespace}.svc.cluster.local`);
    expect(envValue(deployment, 'UPSTREAM_PORT')).toBe(port);
  });

  it('ゲートウェイの集計画面をクラスタの外に出さない', () => {
    // gate.js の :8090 は認証を持たない。Cloudflare Access を通さずに出すと誰でも見られる。
    expect(blockOf(gate, 'Service')).toMatch(/^  type: ClusterIP$/m);
  });

  it('ゲートウェイのソースは LF のまま、Node で読める', () => {
    // kustomize は中身をそのまま ConfigMap に詰める。CRLF に変わるとクラスタの中身も変わる。
    const source = readFileSync('deploy/gate/gate.js', 'utf8');
    expect(source.includes('\r'), '.gitattributes の eol=lf が効いていない').toBe(false);
    const check = spawnSync(process.execPath, ['--check', 'deploy/gate/gate.js'], { encoding: 'utf8' });
    expect(check.status, check.stderr).toBe(0);
  });
});
