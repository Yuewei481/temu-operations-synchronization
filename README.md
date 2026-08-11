# TEMU & SHEIN Operations Synchronization

半自动采集 TEMU、SHEIN 店铺商品每日销量，使用本地 Excel 对照商品名称，并将明细与每日总销量输出到 Excel 或 WPS 云表格。

项目使用本机安装的普通 Google Chrome，通过 Chrome DevTools Protocol（CDP）控制独立浏览器 Profile。首次运行时由用户手动登录，脚本负责等待、识别登录完成并继续执行。

## 功能

- 按一个或多个日期采集 TEMU 商品销量。
- 遍历 TEMU 销售管理的全部分页，不跳过最后一页。
- 按一个或多个连续日期范围采集 SHEIN 商品销量。
- 遍历 SHEIN 商品明细的全部分页和全部商品。
- SHEIN 趋势弹窗只选择“销量”，并验证图表日期已经真正刷新。
- 读取供方货号时去除字母和符号、保留数字。
- 使用同一个 Excel 对照表匹配 TEMU 和 SHEIN 商品。
- 先匹配对照表 A 列，未找到时再匹配 B 列，名称读取 C 列；列号可以配置。
- 对照表中不存在的商品不会进入输出，也不会计入每日总销量。
- 支持三个互斥输出模式：新建 Excel、更新本地 Excel、更新 WPS 云表格。
- WPS 明细按“日期 + 商品名称”匹配，存在则更新，不存在则追加。
- WPS 每日总销量按日期匹配，存在则更新，不存在则追加。
- TEMU、SHEIN 和每个账号可以指定独立的 WPS 文档、Sheet、列和起始行，也可以共用相同目标。
- 支持多个 TEMU 账号和多个 SHEIN 账号顺序执行。
- WPS 未登录时持续等待；登录完成、目标文档稳定且编辑 API 可用后才开始写入。
- 每个账号使用独立 Chrome Profile，保存各自登录状态。

## 完整流程

运行主程序后，脚本按以下顺序工作：

1. 启动 TEMU 账号专用 Chrome。
2. 等待用户登录并进入 TEMU Seller Central。
3. 遍历销售管理全部页面，读取目标日期的商品销量。
4. 使用本地 Excel 匹配商品名称。
5. 按所选输出模式写入结果。
6. 如果使用 WPS，计算对照成功商品的每日总销量并写入总销量区域。
7. 所有 TEMU 账号完成后关闭其 Chrome。
8. 如果启用 SHEIN，逐个启动 SHEIN 账号专用 Chrome。
9. 等待登录，遍历全部商品页和趋势弹窗。
10. 完成 SHEIN 明细与每日总销量输出。
11. 成功后关闭自动化 Chrome。

任一步骤失败时，程序以非零退出码结束，不会把后续错误结果继续写入。

## 环境要求

- Windows 10/11 或 macOS
- Git
- Node.js 20 或更高版本
- Python 3.10 或更高版本
- Google Chrome

Python 依赖：

- `openpyxl`
- `Pillow`

Node.js 依赖由 `package-lock.json` 锁定。普通 Chrome CDP 主流程不需要执行 `npx playwright install`。

## Windows 安装

### 1. 安装基础软件

安装 Git、Node.js、Python 和 Google Chrome。安装 Python 时勾选 `Add Python to PATH`。

重新打开 PowerShell，确认命令可用：

```powershell
git --version
node -v
npm -v
python --version
```

### 2. 下载项目

```powershell
Set-Location "$HOME\Desktop"
git clone https://github.com/Yuewei481/temu-operations-synchronization.git
Set-Location .\temu-operations-synchronization
```

Git 只负责下载和更新代码。它不负责启动脚本，也不存在标准的 `git start` 命令。

### 3. 安装依赖

```powershell
python -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
npm ci
```

### 4. 创建配置

```powershell
Copy-Item .env.example .env
notepad .env
```

不要把 `.env` 提交到 Git，其中可能包含账号、本机路径和 WPS 文档地址。

## macOS 安装

```bash
git clone https://github.com/Yuewei481/temu-operations-synchronization.git
cd temu-operations-synchronization
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
npm ci
cp .env.example .env
```

macOS Chrome 路径通常为：

```env
CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

## 配置 `.env`

完整字段以 [`.env.example`](./.env.example) 为准。下面是一套单 TEMU、单 SHEIN、WPS 输出的结构示例。

### 全局配置

```env
OUTPUT_MODE=3
TRAFFIC_TARGET_DATES=2026-08-01,2026-08-02,2026-08-03

HUMAN_DELAY_MIN_SECONDS=2
HUMAN_DELAY_MAX_SECONDS=5
WPS_LOGIN_TIMEOUT_MS=1800000
CLOSE_CHROME_AFTER_RUN=1

# 留空时自动查找 Chrome
CHROME_PATH=
```

输出模式：

| 值 | 行为 |
| --- | --- |
| `1` | 生成新的独立 Excel |
| `2` | 更新已有本地 Excel |
| `3` | 更新 WPS 云表格 |

一次运行只执行选中的一种输出模式。

本地 Excel 模式也支持每日总销量。明细和总销量写入同一个文件时，
`LOCAL_TOTAL_EXCEL_PATH` 可以留空，程序会自动使用 `TARGET_EXCEL_PATH`。
它们也可以使用相同 Sheet 或列；下面为了分别保留明细和总销量，示例使用不同 Sheet：

```env
OUTPUT_MODE=2

ACCOUNT_1_TARGET_EXCEL_PATH=C:/automation-output/sales.xlsx
ACCOUNT_1_TARGET_EXCEL_SHEET_NAME=运营数据记录表
ACCOUNT_1_TARGET_EXCEL_DATE_COLUMN=A
ACCOUNT_1_TARGET_EXCEL_NAME_COLUMN=B
ACCOUNT_1_TARGET_EXCEL_SALES_COLUMN=C
ACCOUNT_1_TARGET_EXCEL_START_ROW=4

ACCOUNT_1_LOCAL_DAILY_TOTAL_ENABLED=1
ACCOUNT_1_LOCAL_TOTAL_EXCEL_PATH=
ACCOUNT_1_LOCAL_TOTAL_SHEET_NAME=总销量表
ACCOUNT_1_LOCAL_TOTAL_DATE_COLUMN=A
ACCOUNT_1_LOCAL_TOTAL_SALES_COLUMN=B
ACCOUNT_1_LOCAL_TOTAL_START_ROW=3
```

多个账户可以把明细写入同一个本地 Excel、同一个 Sheet。为了分别保留各账户结果，建议配置不同列，例如：

```env
ACCOUNT_1_TARGET_EXCEL_PATH=C:/automation-output/sales.xlsx
ACCOUNT_1_TARGET_EXCEL_SHEET_NAME=运营数据记录表
ACCOUNT_1_TARGET_EXCEL_DATE_COLUMN=A
ACCOUNT_1_TARGET_EXCEL_NAME_COLUMN=B
ACCOUNT_1_TARGET_EXCEL_SALES_COLUMN=C

ACCOUNT_2_TARGET_EXCEL_PATH=C:/automation-output/sales.xlsx
ACCOUNT_2_TARGET_EXCEL_SHEET_NAME=运营数据记录表
ACCOUNT_2_TARGET_EXCEL_DATE_COLUMN=E
ACCOUNT_2_TARGET_EXCEL_NAME_COLUMN=F
ACCOUNT_2_TARGET_EXCEL_SALES_COLUMN=G
```

模式 2 和模式 3 不检查写入目标冲突。TEMU 与 SHEIN 的多个账户可以共用：

- 同一个本地 Excel 文件或 WPS 云文档；
- 同一个 Sheet；
- 相同的明细列；
- 相同的总销量位置；
- 相同的中间数据路径。

账户会依次执行，后写入的账户可能更新或覆盖前一个账户的结果。不同列或不同 Sheet 只是保留各账户结果的建议，不是强制要求。

仍然保留以下限制：

- 模式 1 的每个账户必须使用不同的独立输出文件名；
- 不同账户必须使用不同的 CDP 端口；
- 不同账户必须使用不同的 Chrome Profile，以隔离登录会话。

SHEIN 使用同样结构的 `SHEIN_ACCOUNT_1_LOCAL_*` 配置。每日总销量只统计在对照 Excel 中成功匹配的商品。

### TEMU 账号

```env
ACCOUNT_COUNT=1

ACCOUNT_1_NAME=TEMU 1
ACCOUNT_1_CDP_PORT=9222
ACCOUNT_1_CHROME_PROFILE=C:/automation-profiles/temu1

ACCOUNT_1_SOURCE_EXCEL=C:/automation-data/SKU SKC 品名.xlsx
ACCOUNT_1_SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN=A
ACCOUNT_1_SOURCE_EXCEL_SKU_CARGO_SECONDARY_COLUMN=B
ACCOUNT_1_SOURCE_EXCEL_NAME_COLUMN=C

ACCOUNT_1_WPS_DOC_URL=https://www.kdocs.cn/l/your-document-id
ACCOUNT_1_WPS_SHEET_NAME=运营数据记录表
ACCOUNT_1_WPS_DATE_COLUMN=A
ACCOUNT_1_WPS_NAME_COLUMN=B
ACCOUNT_1_WPS_SALES_COLUMN=C
ACCOUNT_1_WPS_START_ROW=4

ACCOUNT_1_WPS_DAILY_TOTAL_ENABLED=1
ACCOUNT_1_WPS_TOTAL_DOC_URL=https://www.kdocs.cn/l/your-document-id
ACCOUNT_1_WPS_TOTAL_SHEET_NAME=总销量表
ACCOUNT_1_WPS_TOTAL_DATE_COLUMN=A
ACCOUNT_1_WPS_TOTAL_SALES_COLUMN=B
ACCOUNT_1_WPS_TOTAL_START_ROW=3
```

`ACCOUNT_1_TRAFFIC_TARGET_DATES` 可以覆盖全局日期；留空时继承 `TRAFFIC_TARGET_DATES`。

### SHEIN 账号

```env
SHEIN_ENABLED=1
SHEIN_ACCOUNT_COUNT=1
SHEIN_OUTPUT_MODE=3
SHEIN_TARGET_DATES=2026-08-01,2026-08-02,2026-08-03
SHEIN_LOGIN_TIMEOUT_MS=1800000
SHEIN_CLOSE_CHROME_AFTER_RUN=1

SHEIN_ACCOUNT_1_NAME=SHEIN 1
SHEIN_ACCOUNT_1_CDP_PORT=9322
SHEIN_ACCOUNT_1_CHROME_PROFILE=C:/automation-profiles/shein1

SHEIN_ACCOUNT_1_SOURCE_EXCEL=C:/automation-data/SKU SKC 品名.xlsx
SHEIN_ACCOUNT_1_SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN=A
SHEIN_ACCOUNT_1_SOURCE_EXCEL_SKU_CARGO_SECONDARY_COLUMN=B
SHEIN_ACCOUNT_1_SOURCE_EXCEL_NAME_COLUMN=C

SHEIN_ACCOUNT_1_WPS_DOC_URL=https://www.kdocs.cn/l/your-document-id
SHEIN_ACCOUNT_1_WPS_SHEET_NAME=运营数据记录表
SHEIN_ACCOUNT_1_WPS_DATE_COLUMN=I
SHEIN_ACCOUNT_1_WPS_NAME_COLUMN=J
SHEIN_ACCOUNT_1_WPS_SALES_COLUMN=K
SHEIN_ACCOUNT_1_WPS_START_ROW=4

SHEIN_ACCOUNT_1_WPS_DAILY_TOTAL_ENABLED=1
SHEIN_ACCOUNT_1_WPS_TOTAL_DOC_URL=https://www.kdocs.cn/l/your-document-id
SHEIN_ACCOUNT_1_WPS_TOTAL_SHEET_NAME=总销量表
SHEIN_ACCOUNT_1_WPS_TOTAL_DATE_COLUMN=G
SHEIN_ACCOUNT_1_WPS_TOTAL_SALES_COLUMN=H
SHEIN_ACCOUNT_1_WPS_TOTAL_START_ROW=3
```

TEMU 和 SHEIN 可以共用同一个对照 Excel，也可以写入同一个 WPS 文档的相同或不同列。

### 多账号规则

- 将 `ACCOUNT_COUNT` 或 `SHEIN_ACCOUNT_COUNT` 改成账号数量。
- 复制完整账号区块并递增编号，例如 `ACCOUNT_2_*`。
- 每个账号必须使用不同的 CDP 端口。
- 每个账号必须使用不同的 Chrome Profile 目录。
- 每个账号应配置自己的输出位置和总销量列。

## 启动

### 完整主流程

每次打开新的 PowerShell：

```powershell
Set-Location "$HOME\Desktop\temu-operations-synchronization"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
npm start
```

`npm start` 等价于：

```powershell
npm run sync-wps:accounts
```

它只运行本地代码，不会自动从 GitHub 更新。需要更新时先执行：

```powershell
git pull
npm ci
python -m pip install -r requirements.txt
```

### 只运行 SHEIN

```powershell
npm run sync-shein
```

### 只采集 TEMU 销量

```powershell
npm run collect-sales:cdp
```

### 运行测试

```powershell
npm test
python -m unittest discover -s tests -p "test_*.py"
```

## 首次运行

脚本会打开独立的普通 Chrome 窗口。

- 首次 TEMU 运行：登录 TEMU，并按页面要求进入对应店铺。
- 首次 SHEIN 运行：登录 SHEIN，脚本检测到主页后自动进入商品明细。
- WPS 输出模式：在每个独立 Chrome Profile 中登录 WPS。

不需要在终端输入“已登录”。脚本会持续检测：

1. 登录提示是否消失。
2. 是否回到正确的 WPS 文档 URL。
3. 目标文档是否稳定。
4. 目标 Sheet 和 WPS OpenAPI 是否可用。

未登录时即使文档可以公开查看，脚本也不会开始写入。

## 输出文件

主要中间结果位于 `output/`：

```text
output/sales-data.json
output/wps-append-payload.json
output/temu-account-1-daily-totals.json
output/shein-account-1-sales-data.json
output/shein-account-1-wps-payload.json
output/shein-account-1-daily-totals.json
```

这些文件用于检查、恢复写入和定位问题，不建议提交到 Git。

## 常见问题

### `npm start` 是否会运行 Git？

不会。`npm start` 只执行当前文件夹中的主脚本。Git 更新需要单独运行 `git pull`。

### PowerShell 不允许激活虚拟环境

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

### 找不到 Chrome

在 `.env` 设置：

```env
CHROME_PATH=C:/Program Files/Google/Chrome/Application/chrome.exe
```

### Python 报告缺少 `openpyxl` 或 `PIL`

确认已经激活 `.venv`，然后执行：

```powershell
python -m pip install -r requirements.txt
```

### WPS 一直等待登录

- 在脚本打开的独立 Chrome 中登录，而不是日常 Chrome。
- 确认登录后返回配置的目标 WPS 文档。
- 不要关闭脚本打开的 Chrome。
- 默认最多等待 30 分钟，可通过 `WPS_LOGIN_TIMEOUT_MS` 调整。

### SHEIN 日期看起来先切到前一天

这是刷新保护逻辑。脚本会先选择目标范围外的临时日期，确认旧图表已经变化，再切回目标日期范围并验证图表轴。

### 商品没有出现在结果中

只有能在对照 Excel 主列或备用列中匹配到的商品才会输出并计入总销量。

## 安全与数据

- 不要提交 `.env`。
- 不要提交登录 Profile。
- 不要提交真实业务输出和临时截图。
- 不建议使用 Playwright 内置浏览器登录 TEMU；主流程使用本机普通 Chrome。
- 不要让多个账号共用 CDP 端口或 Chrome Profile。
- WPS 写入前会核验文档、Sheet 和列配置，但仍建议先在测试 Sheet 验证新配置。

## 已验证场景

当前版本已经完成以下端到端测试：

- 单 TEMU、单 SHEIN 顺序执行。
- TEMU 3 页商品全部遍历。
- SHEIN 2 页、11 个商品全部遍历。
- 多日期销量读取。
- A 列优先、B 列备用、C 列商品名称。
- WPS 明细匹配更新与追加。
- 仅对照成功商品参与每日总销量。
- WPS 从未登录开始等待，登录后自动继续。
- TEMU/SHEIN 独立 Chrome Profile 与自动关闭。

## License

本项目当前未声明开源许可证。未经项目所有者许可，不应将代码用于公开再发布或商业分发。
