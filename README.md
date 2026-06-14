# word-of-mouth-marketing-easier-ai-backend

GBP投稿管理システムのバックエンド API（Express 5 + Prisma + PostgreSQL）。

## セットアップ

```bash
cp .env.example .env
npm install
npm run db:push
npm run db:seed
npm run dev
```

本番:

```bash
npm run build
npm start
```

## 環境変数

`.env.example` を参照。最低限:

- `DATABASE_URL` — PostgreSQL 接続文字列（Neon では **pooler** URL）
- `DIRECT_URL` — Neon の **direct** URL（`prisma db push` / migrate 用）
- `JWT_SECRET` — 認証用シークレット
- `FRONTEND_URL` — フロントエンド URL（CORS）
- `PUBLIC_API_URL` — 画像 URL 生成用の公開 API ベース URL

### Neon PostgreSQL

1. Neon コンソールで **pooled** と **direct** の接続文字列を取得
2. `.env` に設定（`sslmode=require` を付与。`channel_binding=require` は Node/Prisma で問題が出る場合は省略可）
3. スキーマ同期:

```bash
npm run db:push
npm run db:seed
```

Neon の **Data API**（REST）は本バックエンドでは使用しません。Prisma が PostgreSQL に直接接続します。

## Vercel（フロントエンド）との連携

バックエンドは **Vercel ではなく自社サーバー** で常時起動します（Drive ポーリング・ファイル保存・cron のため）。

Vercel 上の Next.js フロントエンドから接続する場合:

**Vercel 環境変数（フロントエンドプロジェクト）**

| 変数 | 例 |
|------|-----|
| `BACKEND_URL` | `http://103.179.45.111:4000` |
| `NEXT_PUBLIC_API_URL` | `/api` |

**バックエンド `.env`**

```env
FRONTEND_URL=https://word-of-mouth-marketing-easier-ai.vercel.app
ALLOWED_ORIGINS=https://word-of-mouth-marketing-easier-ai.vercel.app
ALLOW_VERCEL_ORIGINS=true
PUBLIC_API_URL=http://103.179.45.111:4000
```

詳細はフロントエンドリポジトリの `VERCEL.md` を参照。

## Vercel（バックエンド）デプロイ

> **推奨:** 本番は VPS（`103.179.45.111:4000`）で常時起動。Drive ポーリング・cron・`uploads/` 保存は Vercel では動きません。

ビルドエラー修正済み。Vercel に接続する場合:

1. GitHub リポジトリ `word-of-mouth-marketing-easier-ai-backend` をインポート
2. **Framework Preset:** Other（`vercel.json` を使用）
3. **環境変数**（Vercel Dashboard → Settings → Environment Variables）:

| 変数 | 必須 |
|------|------|
| `DATABASE_URL` | Neon pooler URL |
| `DIRECT_URL` | Neon direct URL |
| `JWT_SECRET` | 16文字以上 |
| `FRONTEND_URL` | Vercel フロント URL |
| `ALLOW_VERCEL_ORIGINS` | `true` |
| `OPENAI_API_KEY` | OpenAI 用 |
| `PUBLIC_API_URL` | 公開 API URL |

4. Redeploy

## API

- ヘルスチェック: `GET /api/health`
- 認証: `POST /api/auth/login`
