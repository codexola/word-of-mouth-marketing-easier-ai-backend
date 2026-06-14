# Vercel デプロイ手順（バックエンド）

Express + Prisma バックエンドを Vercel Serverless にデプロイする手順です。

## 1. Vercel プロジェクト作成

1. [Vercel](https://vercel.com/) → **Add New → Project**
2. GitHub リポジトリ `word-of-mouth-marketing-easier-ai-backend` をインポート
3. **Framework Preset:** Other（`vercel.json` を使用）
4. **Root Directory:** リポジトリルート（`backend` サブフォルダではない）

## 2. 必須環境変数

Vercel Dashboard → **Settings → Environment Variables**（Production / Preview / Development すべてに設定）

| 変数名 | 例 | 説明 |
|--------|-----|------|
| `DATABASE_URL` | `postgresql://...@...-pooler...neon.tech/db?sslmode=require` | Neon **pooler** URL |
| `DIRECT_URL` | `postgresql://...@....neon.tech/db?sslmode=require` | Neon **direct** URL（Prisma 必須） |
| `JWT_SECRET` | `your-random-secret-min-16-chars` | 認証（16文字以上） |
| `FRONTEND_URL` | `https://word-of-mouth-marketing-easier-ai.vercel.app` | フロント URL |
| `ALLOW_VERCEL_ORIGINS` | `true` | `*.vercel.app` を CORS 許可 |
| `PUBLIC_API_URL` | `https://your-backend.vercel.app` | 画像 URL 生成用（**末尾スラッシュなし**） |
| `OPENAI_API_KEY` | `sk-...` | AI 生成 |
| `NODE_ENV` | `production` | 本番モード |

### Google / LINE（機能ごとに必要なら追加）

- `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_DRIVE_FOLDER_ID`
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`
- `GMAIL_OAUTH_*` / `LINE_CHANNEL_*`
- `DEVELOPER_EMAIL`, `DEVELOPER_PASSWORD`

OAuth コールバック URI は Vercel バックエンド URL に合わせる:

```env
GOOGLE_OAUTH_REDIRECT_URI=https://your-backend.vercel.app/api/gbp/callback
GMAIL_OAUTH_REDIRECT_URI=https://your-backend.vercel.app/api/gmail/callback
```

## 3. フロントエンド（Vercel）との連携

フロントエンド Vercel プロジェクトに設定:

| 変数名 | 値 |
|--------|-----|
| `BACKEND_URL` | `https://your-backend.vercel.app`（末尾スラッシュなし） |
| `NEXT_PUBLIC_API_URL` | `/api` |
| `NEXT_PUBLIC_FRONTEND_URL` | `https://word-of-mouth-marketing-easier-ai.vercel.app` |

フロントは `/api/*` と `/uploads/*` を `BACKEND_URL` へプロキシします。

## 4. デプロイ後の確認

```bash
curl https://your-backend.vercel.app/api/health
# → {"status":"ok","timestamp":"..."}
```

## 5. Vercel の制限（重要）

| 機能 | Vercel | VPS（103.179.45.111） |
|------|--------|------------------------|
| REST API / 認証 / DB | ✅ | ✅ |
| Drive ポーリング（cron） | ❌ 常時起動不可 | ✅ |
| `uploads/` 永続保存 | ❌ `/tmp` のみ（揮発） | ✅ |
| バックグラウンドワーカー | ❌ | ✅ |

**本番推奨:** API は Vercel、Drive 同期・画像保存・cron は VPS で運用。

## 6. トラブルシューティング

| 症状 | 対処 |
|------|------|
| Build で `prisma: command not found` | 最新 `main` を redeploy（`prisma` は dependencies にあり） |
| Build が `prisma generate` で止まる | 数分待つ（Linux バイナリ DL）。`binaryTargets` 設定済み |
| 500 / DB 接続エラー | `DATABASE_URL` と `DIRECT_URL` を確認 |
| CORS エラー | `FRONTEND_URL` + `ALLOW_VERCEL_ORIGINS=true` |
| ログイン失敗 | `JWT_SECRET`、Neon DB にユーザーがいるか `npm run db:seed` |
| 画像 404 | Vercel では uploads 非永続。VPS バックエンドを推奨 |

## 7. 初回 DB セットアップ（ローカルから Neon へ）

```bash
cp .env.example .env   # Neon URL を設定
npm install
npm run db:push
npm run db:seed
```
