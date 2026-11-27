# ATCO Drawing Diff

施工圖 PDF 物件比對網站，可部署在 AWS 供多人同時使用，也能在本機單人執行。上傳 Before / After，網站會解析每頁文字、線條、向量路徑、圖片與批註，排除相同物件，再以左右兩欄顯示差異。

## 架構

同一份程式有兩種執行方式：

- **AWS（多人使用，正式環境）**：ECS + Tailscale + NAT instance。只有加入公司 Tailscale 的員工連得到網站，登入用 Cognito。
- **本機模式**：單人、免登入，全部在自己電腦上執行，用於開發與離線使用。

```
員工電腦 (Tailscale) ══> EC2 t4g.micro：Tailscale subnet router + NAT ──> ECS Fargate：FastAPI 網站（私有子網路，沒有 ALB）
                                                                          │  S3、DynamoDB 走免費 gateway endpoint
瀏覽器 ── 預簽網址直接上傳／下載 ──> S3（PDF 與結果，一天後刪除）              │  SQS 走 NAT
瀏覽器 ── 登入 ──> Cognito                                                 v
                                                SQS ──> 比對 Lambda（不在 VPC 內）──> S3、DynamoDB
```

比對流程：瀏覽器向 `POST /api/uploads` 取得兩個 S3 預簽上傳網址並直接上傳，再呼叫 `POST /api/jobs` 建立工作。網站把工作送進 SQS，由 Lambda 比對，結果寫回 S3。前端輪詢 `GET /api/jobs/{job_id}`，完成後用預簽網址取回結果。重新整理頁面時以 `GET /api/me/last-result` 還原上一次的結果，頁碼與縮放存在 localStorage。

登入與 session：token 放 sessionStorage（關分頁即失效）；access token 1 小時，到期前 5 分鐘若 4 小時內有操作就自動續期（背景輪詢不算操作）；閒置 4 小時跳出「即將登出」提示，2 分鐘無回應就登出；refresh token 12 小時為上限。FastAPI 自己驗證 Cognito access token。

登出：`POST /api/logout` 先把進行中的工作標成 cancelled，再刪除該使用者在 DynamoDB 與 S3 的資料；Lambda 寫入結果前會檢查狀態，已取消就丟棄。DynamoDB TTL 與 S3 lifecycle（24 小時）是保底。

程式位置：

| 路徑 | 內容 |
| --- | --- |
| `compare.py` | PDF 物件解析與比對（不變） |
| `atco_service/app.py` | FastAPI 網站與 API |
| `atco_service/auth.py` | Cognito JWT 驗證 |
| `atco_service/store.py` | job 狀態（DynamoDB／本機記憶體） |
| `atco_service/storage.py` | 檔案（S3 預簽網址／本機資料夾） |
| `atco_service/jobs.py`、`lambda_handler.py` | 比對工作與 SQS 觸發的 Lambda |
| `static/auth.js` | 前端登入、續期、閒置登出 |
| `Dockerfile`、`Dockerfile.compare` | ECS 網站與比對 Lambda 的映像檔 |
| `infra/` | Terraform（部署步驟見 [infra/README.md](infra/README.md)） |

## 本機模式

需要 Python 3.10+、Node.js 22.13+（或 24+）及支援現代 JavaScript 模組的瀏覽器。macOS 可在終端機執行 `./start.command`，或：

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-web.txt
npm ci --omit=dev
python server.py
```

開啟 http://127.0.0.1:8765 。使用 Ctrl+C 停止。另選連接埠：`python server.py --port 8766`。

本機模式不需登入，檔案存在暫存資料夾，比對在背景執行緒進行，伺服器只綁定 127.0.0.1。首次安裝需要網路，之後可離線使用，不依賴 CDN、雲端 API 或外部字型。

## 使用

1. 選取或拖入兩份 PDF（每份最多 30 頁、合計 80 MB）。
2. 按「解析並比對」，等待解析完成（畫面會顯示排隊中或比對中）。
3. 切換頁面；紅色代表修改前，綠色代表修改後。
4. 點選左側差異區域，兩側會同步定位。可同步縮放、捲動。
5. 「顯示」可切換原圖＋差異、淡化原圖及只顯示差異。勾選「包含批註」會繪製 PDF 批註並標出有差異的批註。
6. 展開「PDF 解析資訊」查看每頁的物件數量。

## 比對方式及限制

- 以頁碼配對，保留重複物件數量的 multiset 比對；座標與數值取至小數一位（0.1 pt 的量化，而非距離容差）。
- 比較文字字元、位置、變換矩陣、字型、大小、顏色；向量比較路徑、線寬、填色、描邊與虛線。
- 圖片比較解碼後資料雜湊及位置；批註比較範圍、內容及主要樣式。
- 不是二進位 PDF diff，也不是 OCR 或 CAD 元件識別。改動表示為移除舊物件及新增新物件，清單依物件種類及相近位置推定屬性配對，可能有誤配，需配合圖面確認。文字會組合為詞，顯示修改前後內容。
- 尚未實作自動對齊、頁面重排配對、圖層顯示狀態、完整裁切或透明度語意。圖面整體位移會產生大量差異。浮點量化邊界也可能造成微小誤報。
- 比對 API 回傳各頁的 MediaBox、旋轉角度、物件座標與差異資料。瀏覽器使用 PDF.js 顯示原始檔，並依實際 CropBox 放置 SVG 標示。只顯示差異時，向量以解析路徑繪製，文字、圖片與批註以原圖局部呈現。裁切區內可能同時顯示重疊的共通物件。
- 總覽預覽的最長邊最多 1,200 px。放大後依可見範圍繪製 256 CSS px 的區塊，每個區塊最多 1,024 × 1,024 像素。取樣密度在上限內以至少 300 DPI 或螢幕像素密度為目標。平移和縮放沿用比對結果。來源掃描圖的細節仍取決於原始解析度。
- 以空間網格將差異分組供導覽，區域數不等於修改數。複雜 CAD 匯出可能以多個路徑表達單一元素。
- 解析有頁數及物件數限制。大型文件可能需要數分鐘；AWS 上單次比對受 Lambda 15 分鐘與記憶體設定限制，超過會顯示失敗。

## 驗證

```sh
pip install -r requirements-dev.txt
npm ci
python -m unittest discover -s tests -v   # 含 API、登出清除、JWT 驗證、DynamoDB/S3（moto 模擬）
(cd infra && terraform init -backend=false && terraform test)   # Terraform 離線 plan 檢查
node tests/test_attributes.cjs
node --test tests/test_viewer_layout.mjs
npx playwright install chromium
PYTHON=python node --test tests/test_viewer_browser.mjs
```

合成 PDF 測試包含相同文件、文字／線段變更、新增頁面、圖片變更、批註、頁面旋轉與重複物件處理。

文字差異以詞為單位顯示，不列出不可見文字層的字型或矩陣差異。修改文字周圍符合字形尺寸的細小填色路徑會合併至文字；有描邊的線條、大型圖形及範圍外物件保留。此為幾何推定，小型填色符號與文字重疊時仍可能被歸入文字。
