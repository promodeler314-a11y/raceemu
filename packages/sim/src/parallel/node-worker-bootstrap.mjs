// Node で Worker を TypeScript のまま起動するための足場。
// Node の型剥がしはパラメータプロパティを扱えないため、tsx のローダを登録してから本体を読み込む。
// ブラウザではバンドラが解決するので、このファイルは Node 専用である。
import { register } from 'tsx/esm/api';
register();
await import('./node-worker.ts');
