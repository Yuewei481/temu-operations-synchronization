# TEMU Operations Synchronization

Automates TEMU seller operations data collection, including daily sales, exposure, and click metrics. The script matches products against local Excel reference files, then writes the results into the correct store section of a WPS cloud spreadsheet.

## 本脚本功能

这个项目用于半自动采集 TEMU Seller Central 店铺运营数据，并同步到 WPS 云表格。

主要功能包括：

- 使用本机普通 Google Chrome 登录 TEMU Seller Central，避免使用 Playwright 浏览器登录触发账号异常。
- 通过 Chrome DevTools Protocol 连接已登录的 Chrome 标签页。
- 采集销售管理页面中的商品 SPU 和今日销量。
- 采集欧区流量分析页面中的曝光量、点击量和对应日期。
- 支持 TEMU 商品较少、没有分页按钮的页面。
- 支持多账号顺序采集，例如先采集 `TEMU 1`，再采集 `TEMU 2`。
- 使用本地 Excel 对照表把 SPU 匹配成商品名称。
- 支持每个账号指定不同的 SPU 对照列，例如 `TEMU 1` 使用 A 列，`TEMU 2` 使用 D 列。
- 自动打开或复用 WPS 云表格，切换到指定 sheet。
- 在 WPS 表格第 1 行找到对应店铺区域，例如 `TEMU 1`、`TEMU 2`、`AMAZON`。
- 按 `日期 + SKU/商品名` 匹配已有行，只写入销量、曝光量和点击量，不修改图片列。
- 在点击、读取、翻页、打开详情等步骤中加入 2-5 秒随机等待，尽量模拟真人操作节奏。

## 一、Mac 安装

1. 安装 Node.js 和 Python 3。

   建议使用 Node.js 20 或更高版本。Python 用于处理 Excel 和图片。

2. 克隆项目并进入目录。

   ```bash
   git clone https://github.com/Yuewei481/temu-operations-synchronization.git
   cd temu-operations-synchronization
   ```

3. 安装依赖。

   ```bash
   npm install
   python3 -m pip install -r requirements.txt
   ```

4. 创建配置文件。

   ```bash
   cp .env.example .env
   ```

5. 在 `.env` 中填写 Mac 的 Chrome 路径。

   ```env
   CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
   ```

6. 首次运行时，脚本会打开 Chrome。你需要在该 Chrome 窗口中手动登录 TEMU Seller Central 和 WPS 云文档。

## 二、Windows 安装

1. 安装 Node.js 和 Python 3。

   建议使用 Node.js 20 或更高版本。安装 Python 时建议勾选 `Add Python to PATH`。

2. 安装 Google Chrome。

3. 克隆项目并进入目录。

   ```bat
   git clone https://github.com/Yuewei481/temu-operations-synchronization.git
   cd temu-operations-synchronization
   ```

4. 安装依赖。

   ```bat
   npm install
   python -m pip install -r requirements.txt
   ```

5. 创建 `.env`。

   ```bat
   copy .env.example .env
   ```

6. 在 `.env` 中填写 Windows 的 Chrome 路径。

   常见路径如下：

   ```env
   CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
   ```

   如果 Chrome 安装在用户目录，也可能是：

   ```env
   CHROME_PATH=C:\Users\你的用户名\AppData\Local\Google\Chrome\Application\chrome.exe
   ```

7. 首次运行时，需要在脚本打开的 Chrome 窗口中手动登录 TEMU Seller Central 和 WPS 云文档。登录状态会保存在 `ACCOUNT_*_CHROME_PROFILE` 指定的目录中。

## 三、配置 .env

先复制示例文件：

```bash
cp .env.example .env
```

Windows 可以使用：

```bat
copy .env.example .env
```

`.env` 示例：

```env
SELLER_HOME_WAIT_MS=15000
SELLER_HOME_AFTER_ENTRY_MIN_WAIT_MS=120000
SELLER_HOME_AFTER_ENTRY_TIMEOUT_MS=600000
MANUAL_LOGIN_TIMEOUT_MS=600000

HUMAN_DELAY_MIN_SECONDS=2
HUMAN_DELAY_MAX_SECONDS=5

# Optional. Leave blank to collect yesterday.
# Use one or multiple dates: TRAFFIC_TARGET_DATES=2026-06-09,2026-06-10
TRAFFIC_TARGET_DATES=
TRAFFIC_DATE_RANGE=

WPS_INITIAL_WAIT_MS=120000
WPS_OPENAPI_TIMEOUT_MS=180000
CLOSE_CHROME_AFTER_RUN=1

CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe

WPS_DOC_URL=https://www.kdocs.cn/l/your-wps-document-id
WPS_SHEET_NAME=运营数据记录表

ACCOUNT_COUNT=2

ACCOUNT_1_NAME=TEMU 1
ACCOUNT_1_CDP_PORT=9222
ACCOUNT_1_CHROME_PROFILE=C:\seller-central-profiles\temu1
ACCOUNT_1_SOURCE_EXCEL=C:\seller-central-data\temu-reference.xlsx
ACCOUNT_1_SOURCE_EXCEL_SPU_COLUMN=A
ACCOUNT_1_SOURCE_EXCEL_NAME_COLUMN=B
ACCOUNT_1_SOURCE_EXCEL_IMAGE_COLUMN=C
ACCOUNT_1_GROUP_TITLE=TEMU 1
ACCOUNT_1_TRAFFIC_TARGET_DATES=

ACCOUNT_2_NAME=TEMU 2
ACCOUNT_2_CDP_PORT=9223
ACCOUNT_2_CHROME_PROFILE=C:\seller-central-profiles\temu2
ACCOUNT_2_SOURCE_EXCEL=C:\seller-central-data\temu-reference.xlsx
ACCOUNT_2_SOURCE_EXCEL_SPU_COLUMN=D
ACCOUNT_2_SOURCE_EXCEL_NAME_COLUMN=B
ACCOUNT_2_SOURCE_EXCEL_IMAGE_COLUMN=C
ACCOUNT_2_GROUP_TITLE=TEMU 2
ACCOUNT_2_TRAFFIC_TARGET_DATES=
```

常用字段说明：

- `CHROME_PATH`：本机 Google Chrome 程序路径。脚本通过它启动普通 Chrome。
- `WPS_DOC_URL`：要写入的 WPS 云文档链接。
- `WPS_SHEET_NAME`：要写入的 sheet 名称。
- `WPS_INITIAL_WAIT_MS`：打开 WPS 后先等待多久，给登录和文档加载留时间。
- `WPS_OPENAPI_TIMEOUT_MS`：等待 WPS 表格编辑接口可用的最长时间。
- `CLOSE_CHROME_AFTER_RUN`：设置为 `1` 时，脚本结束后自动关闭当前账号对应的 CDP Chrome。
- `HUMAN_DELAY_MIN_SECONDS` / `HUMAN_DELAY_MAX_SECONDS`：每一步操作之间的随机等待秒数。
- `TRAFFIC_TARGET_DATES`：可选。采集一个或多个流量日期，用逗号分隔，例如 `2026-06-09` 或 `2026-06-09,2026-06-10`；不填写时默认昨天。
- `TRAFFIC_DATE_RANGE`：可选。强制点击流量页的日期范围按钮，例如 `近7日` 或 `近30日`。通常不需要填写，脚本会按目标日期自动选择。
- `ACCOUNT_COUNT`：要顺序处理多少个账号。
- `ACCOUNT_1_NAME`：账号任务名称，只用于日志显示。
- `ACCOUNT_1_CDP_PORT`：这个账号对应的 Chrome 控制端口。
- `ACCOUNT_1_CHROME_PROFILE`：这个账号专用的 Chrome 登录状态目录。
- `ACCOUNT_1_SOURCE_EXCEL`：这个账号使用的本地 Excel 对照表。
- `ACCOUNT_1_SOURCE_EXCEL_SPU_COLUMN`：在本地 Excel 中，哪个列用来匹配 SPU。
- `ACCOUNT_1_SOURCE_EXCEL_NAME_COLUMN`：在本地 Excel 中，哪个列是商品名称。
- `ACCOUNT_1_SOURCE_EXCEL_IMAGE_COLUMN`：在本地 Excel 中，哪个列是商品图片。
- `ACCOUNT_1_GROUP_TITLE`：WPS 表格第 1 行中的店铺区域标题。
- `ACCOUNT_1_TRAFFIC_TARGET_DATES`：可选。只覆盖这个账号的目标流量日期；为空时使用全局日期或默认昨天。

如果只运行一个店铺，可以把 `ACCOUNT_COUNT` 改成 `1`，只保留 `ACCOUNT_1_*`。

## 四、如何运行脚本

### 运行单个账号

先启动对应 Chrome：

```bash
npm run start-chrome:cdp
```

在打开的 Chrome 中手动登录 TEMU Seller Central 和 WPS 云表格。

然后运行完整采集和写入：

```bash
npm run sync-wps
```

### 运行多个账号

如果 `.env` 中配置了 `ACCOUNT_1_*`、`ACCOUNT_2_*`，运行：

```bash
npm run sync-wps:accounts
```

脚本会按顺序执行：

1. 打开或复用 `ACCOUNT_1` 的 Chrome。
2. 等待你完成登录。
3. 采集 `ACCOUNT_1` 的销售数据和流量数据。
4. 使用 `ACCOUNT_1_SOURCE_EXCEL` 和 `ACCOUNT_1_SOURCE_EXCEL_SPU_COLUMN` 匹配商品名称。
5. 写入 WPS 中 `ACCOUNT_1_GROUP_TITLE` 对应区域。
6. 再处理 `ACCOUNT_2`。

### 只采集不写入

```bash
npm run collect-sales:cdp
```

结果会保存到：

```text
output/sales-data.json
```

### 只生成 WPS 写入数据

```bash
npm run build-wps-payload -- C:\seller-central-data\temu-reference.xlsx
```

结果会保存到：

```text
output/wps-append-payload.json
```

### 只写入 WPS

```bash
npm run update-wps
```

这个命令会读取：

```text
output/wps-append-payload.json
```

然后把数据写入 WPS 中匹配到的已有行。

## 常见注意事项

- 不要把 `.env` 上传到 GitHub，里面可能包含本机路径、文档链接或账号配置。
- 不要把 `output/` 上传到 GitHub，里面可能包含采集结果、截图、图片缓存和调试文件。
- 本项目默认使用普通 Chrome，不建议用 Playwright 浏览器登录 TEMU Seller Central。
- 第一次运行某个账号时，需要人工登录 TEMU Seller Central。
- 第一次写入 WPS 时，也需要人工登录 WPS 云文档。
- `CDP_PORT` 必须每个账号不同，例如 `9222`、`9223`。
- `ACCOUNT_*_CHROME_PROFILE` 必须每个账号不同，否则不同店铺的登录状态会混在一起。
- `ACCOUNT_*_SOURCE_EXCEL_SPU_COLUMN`、`ACCOUNT_*_SOURCE_EXCEL_NAME_COLUMN`、`ACCOUNT_*_SOURCE_EXCEL_IMAGE_COLUMN` 要和本地 Excel 真实结构一致。
- `CLOSE_CHROME_AFTER_RUN=1` 只会关闭脚本通过对应 CDP 端口控制的 Chrome，不会主动关闭你的日常 Chrome。
- 如果 TEMU 店铺商品少于分页数量，页面不会显示分页按钮，这是正常情况，脚本会读取当前页。
- 如果流量详情里最上面的日期不是目标日期，但曝光量和点击量为 0，脚本会按目标日期处理，适配 TEMU 对连续 0 数据不更新日期的显示规则。
- 如果配置多个日期，同一个商品会生成多条日期记录；销量会优先读取销售趋势弹窗中对应日期的销量，没有销售趋势入口的商品会按 0 处理。
- 如果 WPS 页面加载慢，可以调大 `WPS_INITIAL_WAIT_MS` 和 `WPS_OPENAPI_TIMEOUT_MS`。
- 如果担心操作太快，可以调大 `HUMAN_DELAY_MIN_SECONDS` 和 `HUMAN_DELAY_MAX_SECONDS`。

## Codex 自动化

这个项目可以配合 Codex 继续开发和测试。

常见 Codex 协作方式：

- 修改 `.env.example` 或 README，让 Windows 用户更容易配置。
- 根据新的 WPS 表格结构，调整店铺区域识别逻辑。
- 根据新的 TEMU 页面结构，调整销售数据或流量数据读取逻辑。
- 让 Codex 运行 `npm test` 验证基础逻辑。
- 让 Codex 用已登录的本地 Chrome 跑一次端到端流程，检查采集和写入是否成功。

建议让 Codex 执行自动化前，先说明：

```text
只使用普通 Chrome CDP，不使用 Playwright 登录。
先等待我手动登录，再继续采集和写入。
```

这样可以减少账号风控风险，也方便你人工确认页面状态。
