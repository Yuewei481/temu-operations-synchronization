# TEMU Operations Synchronization

Automates TEMU seller operations data collection, product-name matching, and sales export. Each account can independently export a new workbook, update an existing local workbook, or update explicitly configured columns in a WPS cloud spreadsheet.

## 本脚本功能

这个项目用于半自动采集 TEMU Seller Central 店铺运营数据，并同步到 WPS 云表格。

主要功能包括：

- 使用本机普通 Google Chrome 登录 TEMU Seller Central，避免使用 Playwright 浏览器登录触发账号异常。
- 通过 Chrome DevTools Protocol 连接已登录的 Chrome 标签页。
- 采集销售管理页面中的商品 SKU货号和销量。
- 相同的 SKU货号按同一个商品处理，重复出现时不会累加销量。
- 根据 `OUTPUT_MODE`，每个账号只执行一种输出：生成新 Excel、更新已有本地 Excel，或更新 WPS 云 Excel。
- 采集欧区流量分析页面中的曝光量、点击量和对应日期。
- 支持 TEMU 商品较少、没有分页按钮的页面。
- 支持多账号顺序采集，例如先采集 `TEMU 1`，再采集 `TEMU 2`。
- SKU货号会删除英文字母和符号，只保留数字，例如 `ZZ-20250702` 会转换为 `20250702`。
- 使用本地 Excel 对照表匹配商品名称：先查第 1 列，未找到再查第 2 列，名称读取同一行第 3 列。
- 第一列和第二列都找不到货号时，直接忽略该商品，不生成待写入数据。
- 在 WPS 模式下自动打开或复用每个账号配置的云表格，并切换到指定工作表。
- WPS 的日期列、商品名称列、销量列和起始行均由每个账号明确配置，不再依赖第一行的店铺分组标题。
- 按 `日期 + 商品名` 匹配已有行并更新销量；找不到时在数据末尾追加日期、商品名和销量，不修改其他列。
- 在点击、读取、翻页、打开详情等步骤中加入 2-5 秒随机等待，尽量模拟真人操作节奏。

## 一、Mac 安装

### 1. 安装基础软件

Mac 需要安装：

- Git
- Node.js 20 或更高版本
- Python 3.10 或更高版本
- Google Chrome

打开 Terminal 检查版本：

```bash
git --version
node -v
npm -v
python3 --version
```

### 2. 下载项目

```bash
cd ~/Documents
git clone https://github.com/Yuewei481/temu-operations-synchronization.git
cd temu-operations-synchronization
```

### 3. 创建 Python 虚拟环境并安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
npm install
```

以后每次重新打开 Terminal 运行项目前，先执行：

```bash
cd ~/Documents/temu-operations-synchronization
source .venv/bin/activate
```

### 4. 创建配置文件

```bash
cp .env.example .env
open -e .env
```

Mac 的 Chrome 路径可以留空让脚本自动查找，也可以明确填写：

```env
CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

首次运行时，需要在脚本打开的 Chrome 窗口中手动登录 TEMU Seller Central；只有 `OUTPUT_MODE=3` 时还需要登录 WPS。

## 二、Windows 安装

Windows 可以选择 Git Bash 或 PowerShell。选定一种后，建议从安装到运行都使用同一种终端。

### 1. 安装基础软件

Windows 需要安装：

- [Git for Windows](https://git-scm.com/download/win)
- Node.js 20 或更高版本
- Python 3.10 或更高版本
- Google Chrome

安装 Python 时勾选 `Add Python to PATH`。安装完成后关闭旧终端，再打开新的 Git Bash 或 PowerShell。

检查版本：

```text
git --version
node -v
npm -v
python --version
```

### 2A. 使用 Git Bash 安装

```bash
cd /c/Users/你的用户名/Desktop
git clone https://github.com/Yuewei481/temu-operations-synchronization.git
cd temu-operations-synchronization
python -m venv .venv
source .venv/Scripts/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
npm install
cp .env.example .env
notepad .env
```

以后每次重新打开 Git Bash，先进入项目并激活这个项目自己的虚拟环境：

```bash
cd /c/Users/你的用户名/Desktop/temu-operations-synchronization
source .venv/Scripts/activate
```

### 2B. 使用 PowerShell 安装

```powershell
Set-Location "$HOME\Desktop"
git clone https://github.com/Yuewei481/temu-operations-synchronization.git
Set-Location .\temu-operations-synchronization
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
npm install
Copy-Item .env.example .env
notepad .env
```

如果 PowerShell 拒绝激活虚拟环境，可以只对当前终端临时允许：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

以后每次重新打开 PowerShell，先执行：

```powershell
Set-Location "$HOME\Desktop\temu-operations-synchronization"
.\.venv\Scripts\Activate.ps1
```

### 3. Windows Chrome 和路径配置

`CHROME_PATH` 可以留空，脚本会自动检查 Chrome 的常见安装位置。自动查找失败时再填写：

```env
CHROME_PATH=C:/Program Files/Google/Chrome/Application/chrome.exe
```

或：

```env
CHROME_PATH=C:/Users/你的用户名/AppData/Local/Google/Chrome/Application/chrome.exe
```

Windows 的 `.env` 路径推荐使用 `C:/...` 格式，不要使用中文引号。首次运行时，脚本会为每个账号打开独立的普通 Chrome 窗口，登录状态保存在 `ACCOUNT_*_CHROME_PROFILE` 指定的目录中。

## 三、配置 .env

先复制示例文件：

```bash
cp .env.example .env
```

Windows 可以使用：

```bat
copy .env.example .env
```

完整配置请以 [`.env.example`](./.env.example) 为准。下面是两个账号的关键结构：

```env
CHROME_PATH=
ACCOUNT_COUNT=2
# 1=只生成新 Excel，2=只更新已有本地 Excel，3=只更新 WPS 云 Excel
OUTPUT_MODE=1

ACCOUNT_1_NAME=TEMU 1
ACCOUNT_1_CDP_PORT=9222
ACCOUNT_1_CHROME_PROFILE=C:/seller-central-profiles/temu1
ACCOUNT_1_SOURCE_EXCEL=C:/seller-central-data/SKU SKC 品名.xlsx
ACCOUNT_1_SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN=A
ACCOUNT_1_SOURCE_EXCEL_SKU_CARGO_SECONDARY_COLUMN=B
ACCOUNT_1_SOURCE_EXCEL_NAME_COLUMN=C
ACCOUNT_1_SOURCE_EXCEL_IMAGE_COLUMN=

# OUTPUT_MODE=1 时使用。
ACCOUNT_1_EXPORT_EXCEL_PATH=C:/seller-central-output/temu1-sales.xlsx

# OUTPUT_MODE=2 时使用。
ACCOUNT_1_TARGET_EXCEL_PATH=
ACCOUNT_1_TARGET_EXCEL_SHEET_NAME=运营数据记录表
ACCOUNT_1_TARGET_EXCEL_DATE_COLUMN=A
ACCOUNT_1_TARGET_EXCEL_NAME_COLUMN=B
ACCOUNT_1_TARGET_EXCEL_SALES_COLUMN=C
ACCOUNT_1_TARGET_EXCEL_START_ROW=2

ACCOUNT_1_TRAFFIC_TARGET_DATES=

# OUTPUT_MODE=3 时使用。
ACCOUNT_1_WPS_DOC_URL=
ACCOUNT_1_WPS_SHEET_NAME=运营数据记录表
ACCOUNT_1_WPS_DATE_COLUMN=A
ACCOUNT_1_WPS_NAME_COLUMN=B
ACCOUNT_1_WPS_SALES_COLUMN=C
ACCOUNT_1_WPS_START_ROW=2

ACCOUNT_2_NAME=TEMU 2
ACCOUNT_2_CDP_PORT=9223
ACCOUNT_2_CHROME_PROFILE=C:/seller-central-profiles/temu2
ACCOUNT_2_SOURCE_EXCEL=C:/seller-central-data/SKU SKC 品名.xlsx
ACCOUNT_2_SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN=A
ACCOUNT_2_SOURCE_EXCEL_SKU_CARGO_SECONDARY_COLUMN=B
ACCOUNT_2_SOURCE_EXCEL_NAME_COLUMN=C
ACCOUNT_2_SOURCE_EXCEL_IMAGE_COLUMN=
ACCOUNT_2_EXPORT_EXCEL_PATH=C:/seller-central-output/temu2-sales.xlsx
ACCOUNT_2_TARGET_EXCEL_PATH=
ACCOUNT_2_TARGET_EXCEL_SHEET_NAME=运营数据记录表
ACCOUNT_2_TARGET_EXCEL_DATE_COLUMN=E
ACCOUNT_2_TARGET_EXCEL_NAME_COLUMN=F
ACCOUNT_2_TARGET_EXCEL_SALES_COLUMN=G
ACCOUNT_2_TARGET_EXCEL_START_ROW=2
ACCOUNT_2_TRAFFIC_TARGET_DATES=
ACCOUNT_2_WPS_DOC_URL=
ACCOUNT_2_WPS_SHEET_NAME=运营数据记录表
ACCOUNT_2_WPS_DATE_COLUMN=A
ACCOUNT_2_WPS_NAME_COLUMN=B
ACCOUNT_2_WPS_SALES_COLUMN=C
ACCOUNT_2_WPS_START_ROW=2
```

常用字段说明：

- `CHROME_PATH`：普通 Google Chrome 的程序路径。留空时会在 Windows、macOS 或 Linux 的常见安装位置中自动查找；自动查找失败时再填写完整路径。
- `ACCOUNT_COUNT`：顺序处理的账号数量。设置为 `3` 并补齐 `ACCOUNT_3_*` 后，就会处理三个账号。
- `OUTPUT_MODE`：必填且只能是 `1`、`2` 或 `3`。`1` 只生成新 Excel；`2` 只更新已有本地 Excel；`3` 只更新 WPS 云 Excel。脚本只会读取并校验当前模式所需的目标配置。
- `COLLECT_SALES_ONLY`：设为 `1` 时只采集 SKU 货号和销量，不进入曝光量、点击量流程。
- `TRAFFIC_TARGET_DATES`：所有账号默认使用的目标日期，多个日期用逗号分隔；为空时默认昨天。
- `ACCOUNT_1_TRAFFIC_TARGET_DATES`：账号自己的日期配置；填写后优先于全局日期，为空时继承全局日期。
- `ACCOUNT_1_SOURCE_EXCEL`：SKU 货号与商品名称的本地对照表。
- `ACCOUNT_1_SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN`：优先查询货号的列。
- `ACCOUNT_1_SOURCE_EXCEL_SKU_CARGO_SECONDARY_COLUMN`：主列找不到时继续查询的列。
- `ACCOUNT_1_SOURCE_EXCEL_NAME_COLUMN`：匹配成功后读取商品名称的列。
- `ACCOUNT_1_EXPORT_EXCEL_PATH`：仅 `OUTPUT_MODE=1` 需要。必须是包含 `.xlsx` 文件名的完整路径；多个账号必须使用不同路径。
- `ACCOUNT_1_TARGET_EXCEL_PATH`：仅 `OUTPUT_MODE=2` 需要，指向要更新的已有本地工作簿。
- `ACCOUNT_1_TARGET_EXCEL_SHEET_NAME`：已有本地工作簿中要更新的工作表。
- `ACCOUNT_1_TARGET_EXCEL_DATE_COLUMN` / `NAME_COLUMN` / `SALES_COLUMN`：已有本地工作簿中日期、名称、销量所在列。
- `ACCOUNT_1_TARGET_EXCEL_START_ROW`：开始匹配或新增数据的首行。
- `ACCOUNT_1_WPS_DOC_URL`：仅 `OUTPUT_MODE=3` 需要，是这个账号自己的 WPS 文档链接。
- `ACCOUNT_1_WPS_SHEET_NAME`：WPS 中要更新的工作表。
- `ACCOUNT_1_WPS_DATE_COLUMN` / `NAME_COLUMN` / `SALES_COLUMN`：WPS 中的日期、商品名称、销量列。
- `ACCOUNT_1_WPS_START_ROW`：WPS 中开始查找日期和名称的首行；找不到对应行时，从已用数据的末行下方追加。
- `WPS_INITIAL_WAIT_MS`：打开 WPS 后预留给登录及文档加载的时间。
- `CLOSE_CHROME_AFTER_RUN`：设为 `1` 时，成功完成后关闭当前账号的 CDP Chrome。

同一个商品的多个日期会各占一行，例如：

```text
2026/7/31    商品A    5
2026/8/1     商品A    8
```

如果只运行一个店铺，将 `ACCOUNT_COUNT` 改成 `1`。增加账号时复制完整的账号配置块并修改编号、端口、Chrome Profile、导出路径和目标位置。

## 四、如何运行脚本

### 运行单个账号

将 `ACCOUNT_COUNT=1`，填写完整的 `ACCOUNT_1_*` 配置，然后运行：

```bash
npm run sync-wps:accounts
```

脚本会启动 `ACCOUNT_1_CHROME_PROFILE` 对应的 Chrome。首次使用时，在打开的窗口中手动登录 TEMU；仅当 `OUTPUT_MODE=3` 时还需要登录 WPS。采集完成后会严格执行 `OUTPUT_MODE` 指定的唯一一种输出方式。例如只想生成新 Excel：

```env
OUTPUT_MODE=1
```

也可以只根据现有的 `output/sales-data.json` 重新生成两列销量表：

```bash
npm run export-sku-sales
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
4. 使用 `ACCOUNT_1_SOURCE_EXCEL`，依次查询货号主列和备用列，并读取名称列。
5. 根据 `OUTPUT_MODE` 只执行以下一项：新建导出 Excel、更新已有本地 Excel，或更新 WPS 云 Excel。
6. 再以完全独立的路径和目标配置处理 `ACCOUNT_2`。如果 `ACCOUNT_COUNT=3`，则继续以相同规则处理 `ACCOUNT_3`。

### 只采集不写入

```bash
npm run collect-sales:cdp
```

结果会保存到：

```text
output/sales-data.json
```

### 高级：只生成写入数据

```bash
npm run build-wps-payload -- C:\seller-central-data\temu-reference.xlsx
```

结果会保存到：

```text
output/wps-append-payload.json
```

### 高级：只写入 WPS

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
- `ACCOUNT_*_SOURCE_EXCEL_SKU_CARGO_PRIMARY_COLUMN`、`ACCOUNT_*_SOURCE_EXCEL_SKU_CARGO_SECONDARY_COLUMN`、`ACCOUNT_*_SOURCE_EXCEL_NAME_COLUMN` 要和本地 Excel 真实结构一致。
- `CLOSE_CHROME_AFTER_RUN=1` 只会关闭脚本通过对应 CDP 端口控制的 Chrome，不会主动关闭你的日常 Chrome。
- 如果 TEMU 店铺商品少于分页数量，页面不会显示分页按钮，这是正常情况，脚本会读取当前页。
- 如果流量详情里最上面的日期不是目标日期，但曝光量和点击量为 0，脚本会按目标日期处理，适配 TEMU 对连续 0 数据不更新日期的显示规则。
- 如果配置多个日期，同一个商品会生成多条日期记录；销量会优先读取销售趋势弹窗中对应日期的销量，没有销售趋势入口的商品会按 0 处理。
- 如果 WPS 页面加载慢，可以调大 `WPS_INITIAL_WAIT_MS` 和 `WPS_OPENAPI_TIMEOUT_MS`。
- 如果担心操作太快，可以调大 `HUMAN_DELAY_MIN_SECONDS` 和 `HUMAN_DELAY_MAX_SECONDS`。

### Windows 常见报错

#### `ModuleNotFoundError: No module named 'PIL'`

说明当前 Python 环境没有安装 `requirements.txt`。先进入项目并激活 `.venv`，再运行：

```text
python -m pip install -r requirements.txt
```

#### `fatal: not a git repository`

说明当前终端不在项目目录。先进入 `temu-operations-synchronization` 文件夹，再执行 `git pull`。

#### PowerShell 无法激活 `.venv`

对当前 PowerShell 窗口临时放行后重试：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

## Codex 自动化

这个项目可以配合 Codex 继续开发和测试。

常见 Codex 协作方式：

- 修改 `.env.example` 或 README，让 Windows 用户更容易配置。
- 根据新的 WPS 表格结构，调整每个账号的工作表、列位置和起始行配置。
- 根据新的 TEMU 页面结构，调整销售数据或流量数据读取逻辑。
- 让 Codex 运行 `npm test` 验证基础逻辑。
- 让 Codex 用已登录的本地 Chrome 跑一次端到端流程，检查采集和写入是否成功。

建议让 Codex 执行自动化前，先说明：

```text
只使用普通 Chrome CDP，不使用 Playwright 登录。
先等待我手动登录，再继续采集和写入。
```

这样可以减少账号风控风险，也方便你人工确认页面状态。
