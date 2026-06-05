# seller central表格填写

Seller Central 表格填写项目。

## 自动登录

先安装依赖：

```bash
npm install
```

复制并编辑环境变量：

```bash
cp .env.example .env
```

当前脚本读取这些变量：

```text
SELLER_PHONE_COUNTRY_CODE=86
SELLER_PHONE=[REMOVED_PERSONAL_PHONE]
SELLER_PASSWORD=[REMOVED_COMPROMISED_PASSWORD]
```

运行登录脚本：

```bash
npm run login
```

默认会打开可见浏览器，方便观察登录流程。需要无头模式时：

```bash
HEADLESS=1 npm run login
```

失败截图会保存到 `output/playwright/login-failure.png`。登录成功后，浏览器状态会保存到 `output/playwright/seller-storage-state.json`，后续脚本可以复用这个登录态。
