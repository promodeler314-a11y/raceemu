# 探索を回すサーバと、同じオリジンで配る静的ファイルを 1 つのイメージに入れる。
# 別オリジンにすると CORS が要り、平文で出すと mixed content で落ちる。
# docs/server-design.md の 5 節を参照。

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/ packages/
COPY apps/ apps/
COPY scripts/ scripts/
RUN pnpm install --frozen-lockfile
RUN pnpm build
# 画面の読み取りに使う学習データ。35 MB あるのでリポジトリには置かず、ここで取る。
RUN node scripts/fetch-tessdata.mjs /app/tessdata

FROM node:22-slim AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
# Worker は node-worker-bootstrap.mjs が tsx のローダを登録してから
# TypeScript の本体を読み込む。Node の型剥がしがパラメータプロパティを
# 扱えないためで、つまり tsx は実行時に要る。
# それで devDependencies を落とさずそのまま持ってきている。
# 落としたい場合は tsx を dependencies に移すか、Worker を含めて
# あらかじめコンパイルする必要がある。
COPY --from=build /app /app
ENV RACEEMU_STATIC_ROOT=/app/apps/web/dist
ENV RACEEMU_TESSDATA=/app/tessdata
EXPOSE 8080
USER node
# シグナルを PID 1 で受けたいので、パッケージマネージャを挟まない。
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
