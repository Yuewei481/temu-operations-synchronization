# seller central表格填写

Seller Central 表格填写项目。

## 登录

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
BROWSER_CHANNEL=chrome
USER_DATA_DIR=output/playwright/browser-profile
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

如果希望像手动登录一样打开本机 Chrome，保留：

```text
BROWSER_CHANNEL=chrome
HEADLESS=0
```

更推荐先用自己的 Chrome 手动登录，避免触发账号风控：

```bash
npm run open-login
```

这个命令只会用本机 Google Chrome 打开卖家中心登录页，不会自动输入手机号和密码。你手动登录进入后台以后，我们再让后续脚本接管表格填写等重复操作。

手动登录后，可以检查 Chrome 是否已经打开 Seller Central 后台：

```bash
npm run check-seller-home
```

如果 Chrome 任意标签页跳转到了 `https://agentseller.temu.com/`，命令会打印对应窗口、标签、标题和 URL。

进入后台后，采集销售管理页面中可见商品的 SKU ID 和合计行今日销量：

```bash
npm run collect-sales
```

脚本识别到 `https://agentseller.temu.com/` 后默认等待 2 分钟，再按顺序点击左侧 `销售管理`、子菜单 `销售管理`，如遇到提示弹窗会点击 `我知道了`。结果保存到 `output/sales-data.json`。

测试时可以缩短等待时间：

```bash
SELLER_HOME_WAIT_MS=1000 npm run collect-sales
```
