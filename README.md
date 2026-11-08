# Office Tools Pro - SaaS 工具下载网站

一个完整的订阅制办公工具下载网站。用户注册登录后，支付每月 $1.99 即可下载所有工具。支持持续更新。

**适合在中国以外地区发布**（使用 Stripe 支付，支持全球信用卡，无需支付宝/微信支付）。

## 功能

- 用户注册 / 登录
- Stripe 订阅支付（$1.99/月）
- 订阅用户可下载所有工具
- 管理员后台上传/删除工具（持续更新）
- 简洁现代界面（Tailwind CSS）
- SQLite 数据库（无需额外数据库服务）

## 本地运行步骤

1. 安装 Node.js 18+

2. 进入项目目录：
   ```bash
   cd office-tools-site
   npm install
   ```

3. 复制环境变量：
   ```bash
   cp .env.example .env
   ```
   编辑 `.env`，填写：
   - `SESSION_SECRET`：任意随机字符串
   - `STRIPE_SECRET_KEY` 和 `STRIPE_PUBLISHABLE_KEY`：从 [Stripe Dashboard](https://dashboard.stripe.com/apikeys) 获取（先用测试模式）
   - `STRIPE_PRICE_ID`：在 Stripe 创建产品后获取（见下方）
   - `ADMIN_PASSWORD`：你的管理后台密码
   - `APP_URL`：本地用 `http://localhost:3000`

4. 在 Stripe 创建订阅产品：
   - 登录 Stripe Dashboard → Products → Add product
   - 名称：Office Tools Pro
   - Pricing：Recurring → $1.99 USD / month
   - 创建后复制 **Price ID**（以 `price_` 开头）填入 `.env`

5. 启动：
   ```bash
   npm start
   ```
   打开 http://localhost:3000

6. 测试订阅：
   - 注册账号 → 进入 Dashboard → 点击订阅
   - 使用测试卡号：`4242 4242 4242 4242`，任意未来日期和 CVC

7. 上传工具：
   - 访问 http://localhost:3000/admin
   - 输入你设置的 ADMIN_PASSWORD
   - 上传你的工具文件

## Stripe Webhook 设置（生产环境必须）

1. 在 Stripe Dashboard → Developers → Webhooks → Add endpoint
2. Endpoint URL：`https://你的域名/webhook`
3. 选择事件：
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. 复制 Signing secret 填入 `.env` 的 `STRIPE_WEBHOOK_SECRET`

本地测试可用 Stripe CLI：
```bash
stripe listen --forward-to localhost:3000/webhook
```

## 部署到中国以外（推荐）

### 推荐平台（简单、免费/低成本起步）

1. **Render.com**（推荐）
   - 免费套餐可用
   - 连接 GitHub，自动部署
   - 设置环境变量（同 .env）
   - 域名可绑定自定义域名

2. **Railway.app**
   - 同样简单，支持 SQLite

3. **Fly.io** 或 **VPS**（DigitalOcean、Hetzner、AWS Lightsail 等，选择美国/欧洲节点）

### 部署注意事项

- 将项目推送到 GitHub
- 在平台设置所有环境变量（包括 Stripe keys）
- 确保 `APP_URL` 改为你的正式域名
- 上传的工具文件会保存在 `uploads/` 文件夹（注意备份，或后续可改用云存储）
- SQLite 数据库在 `data/app.db`，平台重启时可能需要持久化卷（Render 等支持）

## 自定义

- 修改 `views/` 下的 EJS 模板即可调整界面文字和样式
- 网站名称目前是 “Office Tools Pro”，可全局替换
- 如需中文界面，直接修改模板中的英文文字即可

## 安全提示

- 生产环境请使用 HTTPS
- 妥善保管 Stripe keys 和 ADMIN_PASSWORD
- 建议后续增加邮件验证、密码重置等功能
- 定期备份 `data/` 和 `uploads/` 文件夹

## 技术栈

- Node.js + Express
- SQLite (better-sqlite3)
- Stripe Checkout
- EJS + Tailwind CSS
- Multer 文件上传

---

搭建完成后，你就可以开始上传自己的办公小工具，让用户订阅下载了。祝顺利！
