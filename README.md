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

- `DATABASE_URL` — PostgreSQL 接続文字列
- `JWT_SECRET` — 認証用シークレット
- `FRONTEND_URL` — フロントエンド URL（CORS）
- `PUBLIC_API_URL` — 画像 URL 生成用の公開 API ベース URL

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

## API

- ヘルスチェック: `GET /api/health`
- 認証: `POST /api/auth/login`
